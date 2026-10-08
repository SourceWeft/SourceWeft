import { CloudflareSandboxProvider } from "../src/cloudflare-provider";
import { redactSandboxText } from "../../builtin-tool-sandbox/src/runtime/redaction";
import { sessionProbeEnv } from "../../builtin-tool-sandbox/tests/helpers/session-cancellation-probe";

const env = sessionProbeEnv();
const provider = new CloudflareSandboxProvider({
  bridgeUrl: env.CF_SANDBOX_BRIDGE_URL!,
  apiKey: env.CF_SANDBOX_API_KEY!,
  maxOutputChars: 30_000,
});
let id: string | undefined;
try {
  const sandbox = await provider.createSandbox({
    ttlSeconds: 600,
    labels: { purpose: "sourceweft-workload-boundary-probe" },
  });
  id = sandbox.id;
  console.log(
    JSON.stringify({ event: "probe-sandbox-created", sandboxId: id }),
  );
  const result = await provider.executeSystem({
    providerSandboxId: id,
    timeoutMs: 30_000,
    maxOutputChars: 30_000,
    command: `python3 - <<'PY'
import json,os,pathlib,subprocess
fields=['Name','Uid','Gid','CapEff','CapBnd','NoNewPrivs','State','PPid']
def status(pid):
 out={}
 for line in pathlib.Path('/proc/'+str(pid)+'/status').read_text().splitlines():
  key,_,val=line.partition(':')
  if key in fields:out[key]=val.strip()
 return out
processes=[]
for path in pathlib.Path('/proc').iterdir():
 if path.name.isdigit():
  try:processes.append({'pid':int(path.name),**status(path.name)})
  except FileNotFoundError:pass
probes={}
for name,args in {'user_pid_namespace':['unshare','--user','--map-root-user','--pid','--fork','true'],'dedicated_uid':['setpriv','--reuid=65534','--regid=65534','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','id']}.items():
 try:
  r=subprocess.run(args,capture_output=True,text=True,timeout=5)
  probes[name]={'exitCode':r.returncode,'stdout':r.stdout.strip(),'stderr':r.stderr.strip()}
 except Exception as e:probes[name]={'error':type(e).__name__}
print(json.dumps({'self':status('self'),'pid1':status(1),'processes':processes,'cgroup':pathlib.Path('/proc/self/cgroup').read_text(),'cgroup_writable':os.access('/sys/fs/cgroup',os.W_OK),'cgroup_controllers':pathlib.Path('/sys/fs/cgroup/cgroup.controllers').read_text() if pathlib.Path('/sys/fs/cgroup/cgroup.controllers').exists() else None,'probes':probes}))
PY`,
  });
  if (result.exitCode !== 0)
    throw new Error(`Boundary probe failed with exit ${result.exitCode}`);
  console.log(result.output);
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error
          ? redactSandboxText(error.message)
          : "workload boundary probe failed",
    }),
  );
  process.exitCode = 1;
} finally {
  if (id) {
    await provider.deleteSandbox(id);
    console.log(
      JSON.stringify({ event: "probe-sandbox-deleted", sandboxId: id }),
    );
  }
}
