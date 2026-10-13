/**
 * Interactive confirmation (D-an, spine §5 reading 71): a question answered by the human at the
 * terminal. Only when stdin and stdout are both TTYs; anywhere else (a host session's Bash tool,
 * a pipe, a script) there is nobody to ask and the answer is no. One line is read from stdin
 * directly (`node:readline` is not on the runtime-safe built-in list, AD-2).
 */

/** True when stdin and stdout are both terminals (`isTTY` is undefined on anything else). */
export const interactiveTerminal = (): boolean => process.stdin.isTTY && process.stdout.isTTY;

/** Reads one line from stdin; `null` when stdin ends first. */
const readLine = (): Promise<string | null> =>
  new Promise((resolve) => {
    let text = "";
    const finish = (value: string | null): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const at = text.indexOf("\n");
      if (at >= 0) finish(text.slice(0, at));
    };
    const onEnd = (): void => {
      finish(null);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });

/** Asks `question [y/N]` at the terminal; `false` without one or on anything but yes. */
export const ttyConfirm = async (question: string): Promise<boolean> => {
  if (!interactiveTerminal()) return false;
  process.stdout.write(`${question} [y/N] `);
  const answer = await readLine();
  return answer !== null && /^y(es)?$/i.test(answer.trim());
};
