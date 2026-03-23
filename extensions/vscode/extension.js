/**
 * Gnosys VS Code Extension — Stub
 *
 * This is a minimal extension stub that demonstrates how to integrate
 * Gnosys with VS Code. Community contributions welcome!
 *
 * Commands:
 *   - Gnosys: Reinforce Memory — increments reinforcement_count on the
 *     currently open .md file if it's inside a .gnosys/ directory.
 *   - Gnosys: Show Dashboard — runs `gnosys dashboard` in the terminal.
 */

const vscode = require("vscode");
const { execSync } = require("child_process");
const path = require("path");

function activate(context) {
  // Command: Reinforce the currently open memory file
  const reinforceCmd = vscode.commands.registerCommand(
    "gnosys.reinforceMemory",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      const filePath = editor.document.uri.fsPath;

      // Check if we're inside a .gnosys directory
      if (!filePath.includes(".gnosys")) {
        vscode.window.showWarningMessage(
          "This file is not inside a .gnosys/ directory."
        );
        return;
      }

      // Find the .gnosys root
      const gnosysIndex = filePath.indexOf(".gnosys");
      const storePath = filePath.substring(0, gnosysIndex + ".gnosys".length);
      const relativePath = path.relative(storePath, filePath);

      try {
        execSync(`npx gnosys reinforce "${relativePath}"`, {
          cwd: path.dirname(storePath),
          timeout: 10000,
        });
        vscode.window.showInformationMessage(
          `Reinforced: ${path.basename(filePath)}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Reinforce failed: ${err.message || err}`
        );
      }
    }
  );

  // Command: Show dashboard in terminal
  const dashboardCmd = vscode.commands.registerCommand(
    "gnosys.runDashboard",
    () => {
      const terminal = vscode.window.createTerminal("Gnosys Dashboard");
      terminal.show();
      terminal.sendText("npx gnosys dashboard");
    }
  );

  context.subscriptions.push(reinforceCmd, dashboardCmd);
}

function deactivate() {}

module.exports = { activate, deactivate };
