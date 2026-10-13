import type { ReactNode } from "react";
import { InlineScript } from "@/components/theme/InlineScript";
import { NO_FLASH_THEME_SCRIPT } from "@/components/theme/theme";
import "./globals.css";

export const metadata = {
  title: "Flow Studio · VTC",
  description: "Read-only view of a VTC run: phases, tasks, pipelines, escalations and usage.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <InlineScript html={NO_FLASH_THEME_SCRIPT} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
