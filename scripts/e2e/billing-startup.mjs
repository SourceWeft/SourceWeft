import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
const root=process.cwd();
assert.ok(/^\/sourceweft_billing_test/.test(new URL(process.env.DATABASE_URL).pathname),"Use an isolated test database");
for(const [entry,ready] of [["worker","Primary worker started"],["scheduler","Scheduler started"]]) {
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,`apps/backend/dist/${entry}.js`)],{cwd:path.join(root,"apps/backend"),env:process.env,stdio:["ignore","pipe","pipe"]});
  let output="",seen=false;
  const timer=setTimeout(()=>{child.kill("SIGTERM");reject(new Error(`${entry} startup timed out`));},45000);
  function read(chunk){output+=chunk.toString();if(!seen&&output.includes(ready)){seen=true;child.kill("SIGTERM");}}
  child.stdout.on("data",read);child.stderr.on("data",read);
  child.on("exit",code=>{clearTimeout(timer);if(seen){console.log(`PASS: ${process.env.SOURCEWEFT_EDITION} ${entry} startup`);resolve();}else reject(new Error(`${entry} exited before readiness (${code}): ${output.slice(-1500)}`));});
  child.on("error",error=>{clearTimeout(timer);reject(error);});
 });
}
