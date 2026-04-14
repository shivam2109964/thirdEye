import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ExecutionTreeViewPayload } from '../executionTree';

let panel: vscode.WebviewPanel | undefined;
let isWebviewReady = false;
let pendingPayload: ExecutionTreeViewPayload | undefined;

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

        isWebviewReady = false;
        pendingPayload = undefined;

        panel.onDidDispose(() => {
            panel = undefined;
            isWebviewReady = false;
            pendingPayload = undefined;
        });

        panel.webview.onDidReceiveMessage((msg) => {
            if (msg && typeof msg === 'object' && (msg as any).type === 'ready') {
                isWebviewReady = true;
                if (pendingPayload) {
                    void panel?.webview.postMessage(pendingPayload);
                    pendingPayload = undefined;
                }
            }
        });

        const htmlUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'graph.html');
        const html = fs.readFileSync(htmlUri.fsPath, 'utf8');
        panel.webview.html = html;
    }

    pendingPayload = payload;
    if (isWebviewReady) {
        void panel.webview.postMessage(payload);
        pendingPayload = undefined;
    }
}
