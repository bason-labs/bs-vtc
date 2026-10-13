/**
 * The pinned scanners (§7.2 L4, §15), embedded in the binary. `gates/scanners.json` is the same
 * data for people and `vtc doctor`; `scanner-pins.test.ts` fails when the two differ. Each pin
 * names an exact release and the SHA-256 of every per-platform download, copied from the
 * release's published checksums; nothing is ever auto-updated. Releases were chosen at least two
 * weeks old when pinned (2026-10-13).
 *
 * diff-cover (L3) ships no per-platform binary (it is a Python package), so it is not in the
 * store: calibrate proposes it only when the user has it installed, and the human allowlists it
 * like any other command.
 */
import { ScannerPinsSchema, type Platform, type ScannerPins } from "@vtc/shared";

export const SCANNER_PINS: ScannerPins = ScannerPinsSchema.parse({
  version: 1,
  scanners: [
    {
      name: "gitleaks",
      version: "8.30.1",
      url: "https://github.com/gitleaks/gitleaks/releases/download/v{version}/gitleaks_{version}_{platform}",
      sha256: {
        "darwin-arm64": "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
        "darwin-x64": "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
        "linux-x64": "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
        "linux-arm64": "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
        "windows-x64": "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
      },
      license: "MIT",
    },
    {
      name: "osv-scanner",
      version: "2.6.0",
      url: "https://github.com/google/osv-scanner/releases/download/v{version}/osv-scanner_{platform}",
      sha256: {
        "darwin-arm64": "98c460dcd37de25819babd757d04542045b6243113e209edcd4d89fedb0256b4",
        "darwin-x64": "60c5296637e977b28eeda5c7f13573e447659a632922737f94d11fa7e30ad6ca",
        "linux-x64": "ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108",
        "linux-arm64": "2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4",
        "windows-x64": "e0ed7644118b717b028c249ee9d3515024e55e8510747ca08906eb96765354d6",
      },
      license: "Apache-2.0",
    },
    {
      name: "opengrep",
      version: "1.30.1",
      url: "https://github.com/opengrep/opengrep/releases/download/v{version}/opengrep_{platform}",
      sha256: {
        "darwin-arm64": "7b788794e111ce3fb83f0aa52c100a3b85d37d8b59482262109031f50d4a8d91",
        "darwin-x64": "a8c6d5f51bb38253b48e9a80fca63684aa2a0f9abfeacea27b8d8b5778476bae",
        "linux-x64": "d3195b9d8d5ae93179f6aa5f5daaba6a920a5a09d38c5d5ae5e60924050210c4",
        "linux-arm64": "a730f6fdce1e978ea29e610a2e0503bfe1ec31fce08979a9a84e3699f03e16ee",
        "windows-x64": "d3a45326ff63cabe90d94ebc679fcd4302440178a0e5bf0248a6f7b610db3b53",
      },
      license: "LGPL-2.1",
    },
    {
      name: "checkov",
      version: "3.3.20",
      url: "https://github.com/bridgecrewio/checkov/releases/download/{version}/checkov_{platform}",
      sha256: {
        "darwin-x64": "31c907f5b6f5713804cd4f380b14bb13b6f0e7cda5f1c655fccbd78422e8ea8a",
        "linux-x64": "4e630ff1f25ebb5de9d7adbfe90a869e8356e25f80f4ab456d6fb273358b4e67",
        "linux-arm64": "8cc71b2c8937584017d19b3effa1eb2936c0eeefb06e2e261f71b3a4f90e68cb",
        "windows-x64": "71ce5d764b6f1691df7d6ac8b5bcc7bf2a11f4d2dc1f32a74878e6cc9fc519b8",
      },
      license: "Apache-2.0",
    },
  ],
});

/** How each scanner's release names its downloads: the `{platform}` part and the executable. */
export interface ScannerAssets {
  /** The executable's file name inside the download (without `.exe`). */
  readonly binary: string;
  /** `{platform}` substitution per platform, including the archive extension. */
  readonly platforms: Readonly<Partial<Record<Platform, string>>>;
}

export const SCANNER_ASSETS: Readonly<Record<string, ScannerAssets>> = {
  gitleaks: {
    binary: "gitleaks",
    platforms: {
      "darwin-arm64": "darwin_arm64.tar.gz",
      "darwin-x64": "darwin_x64.tar.gz",
      "linux-x64": "linux_x64.tar.gz",
      "linux-arm64": "linux_arm64.tar.gz",
      "windows-x64": "windows_x64.zip",
    },
  },
  "osv-scanner": {
    binary: "osv-scanner",
    platforms: {
      "darwin-arm64": "darwin_arm64",
      "darwin-x64": "darwin_amd64",
      "linux-x64": "linux_amd64",
      "linux-arm64": "linux_arm64",
      "windows-x64": "windows_amd64.exe",
    },
  },
  opengrep: {
    binary: "opengrep",
    platforms: {
      "darwin-arm64": "osx_arm64",
      "darwin-x64": "osx_x86",
      "linux-x64": "manylinux_x86",
      "linux-arm64": "manylinux_aarch64",
      "windows-x64": "windows_x86.exe",
    },
  },
  checkov: {
    binary: "checkov",
    platforms: {
      "darwin-x64": "darwin_X86_64.zip",
      "linux-x64": "linux_X86_64.zip",
      "linux-arm64": "linux_arm64.zip",
      "windows-x64": "windows_X86_64.zip",
    },
  },
};
