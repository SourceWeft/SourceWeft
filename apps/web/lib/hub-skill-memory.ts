// Session-only selection memory; never share one account's selections with another.
const skills = new Map<string, string[]>();
export const hubSkillMemory = {
  has(account: string, workspace: string, thread: string) {
    return skills.has(JSON.stringify([account, workspace, thread]));
  },
  read(account: string, workspace: string, thread: string) {
    return skills.get(JSON.stringify([account, workspace, thread])) ?? [];
  },
  write(account: string, workspace: string, thread: string, ids: string[]) {
    const key = JSON.stringify([account, workspace, thread]);
    skills.delete(key);
    skills.set(key, [...ids]);
    if (skills.size > 50) skills.delete(skills.keys().next().value!);
  },
  clear() {
    skills.clear();
  },
};
