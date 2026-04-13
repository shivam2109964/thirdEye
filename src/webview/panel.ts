import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ExecutionTreeViewPayload } from '../executionTree';

let panel: vscode.WebviewPanel | undefined;

export function showExecutionTreePanel(context: vscode.ExtensionContext, payload: ExecutionTreeViewPayload) {
    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'thirdeyeGraph',
            'ThirdEye Execution Tree',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
            },
        );

        panel.onDidDispose(() => {
            panel = undefined;
        });
    }

    const htmlUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'graph.html');
    const html = fs.readFileSync(htmlUri.fsPath, 'utf8');
    panel.webview.html = html;

    void panel.webview.postMessage(payload);
}