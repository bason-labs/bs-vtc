/**
 * Contracts 5.6.0 (MINOR; spine §5 reading 232): the round-5 fix round. Command shapes keep no
 * argument value in any form (a here-document's body names no command, and an attached flag value
 * never reaches the flag hash), and an automatic PR that changes files its kind may not is
 * refused with `out_of_scope`.
 */
import { describe, expect, it } from "vitest";
import {
  AutomationSkipReasonSchema,
  commandShapes,
  CONTRACTS_VERSION,
  sha256Hex,
} from "../src/index.js";

const flagHash = (...names: string[]): string =>
  sha256Hex([...new Set(names)].sort().join("\n")).slice(0, 12);

describe("contracts 5.6.0", () => {
  it("is MINOR over 5.5.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  describe("a here-document's body is data, never a command (D-cs)", () => {
    const programs = (command: string): string[] => commandShapes(command).map((s) => s.program);

    it("skips the body up to its delimiter line, for every quoting of the delimiter", () => {
      for (const op of ["<<EOF", "<< EOF", "<<'EOF'", '<<"EOF"', "<<\\EOF"]) {
        const command = `cat > notes.txt ${op}\nacmecorp quarterly secret\nhunter2pass\nEOF\ngit status`;
        expect(programs(command), op).toEqual(["cat", "git"]);
        expect(JSON.stringify(commandShapes(command))).not.toMatch(/acmecorp|hunter2|EOF/);
      }
    });

    it("strips leading tabs of the delimiter line for <<-, and only for <<-", () => {
      expect(programs("cat <<-X\n\thunter2\n\tX\nls")).toEqual(["cat", "ls"]);
      // without the dash a tab-led line is no delimiter: the rest is body
      expect(programs("cat <<X\nhunter2\n\tX\nls")).toEqual(["cat"]);
    });

    it("reads several here-documents of one line in order, and a body with no delimiter to the end", () => {
      expect(programs("paste <<A <<B\nsecret-a\nA\nsecret-b\nB\necho done")).toEqual([
        "paste",
        "echo",
      ]);
      expect(programs("cat <<EOF\nhunter2\nprodsecret")).toEqual(["cat"]);
    });

    it("keeps a here-string (<<<) and a quoted << as they were", () => {
      expect(programs("grep -q x <<< 'hunter2'\nls")).toEqual(["grep", "ls"]);
      expect(programs("echo '<<EOF'\nls")).toEqual(["echo", "ls"]);
    });

    it("keeps the commands after the heredoc operator on its own line", () => {
      expect(programs("cat <<EOF | grep x && wc -l\nhunter2\nEOF")).toEqual(["cat", "grep", "wc"]);
    });
  });

  describe("an attached flag value never reaches the flag hash (D-cs, D-by)", () => {
    it("keeps the first letter of a single-dash word, and a long flag's name", () => {
      expect(commandShapes("mysql -uroot -pS3cret orders")[0]?.flags).toBe(flagHash("-p", "-u"));
      expect(commandShapes("mysql -uadmin -pOther orders")[0]?.flags).toBe(flagHash("-p", "-u"));
      expect(commandShapes("cc -I/abs/path -DKEY=value a.c")[0]?.flags).toBe(flagHash("-D", "-I"));
      expect(commandShapes("ls -la")[0]?.flags).toBe(flagHash("-l"));
      expect(commandShapes("curl --header=x --token=sk-123")[0]?.flags).toBe(
        flagHash("--header", "--token"),
      );
    });

    it("names a numeric flag by its kind, not its number", () => {
      expect(commandShapes("head -20 a.txt")[0]?.flags).toBe(flagHash("-#"));
      expect(commandShapes("head -100 a.txt")[0]?.flags).toBe(flagHash("-#"));
    });
  });

  it("refuses an out-of-scope automatic PR with its own skip reason (D-cn, reading 228(6))", () => {
    expect(AutomationSkipReasonSchema.parse("out_of_scope")).toBe("out_of_scope");
  });
});
