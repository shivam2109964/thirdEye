import * as vscode from 'vscode';
import { parseFile } from './parser';

export function activate(context: vscode.ExtensionContext) {

    console.log('🔥 ThirdEye Activated');

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.ts');

    watcher.onDidChange(uri => {
        console.log("🟡 Changed:", uri.fsPath);

        try {
            const data = parseFile(uri.fsPath);
           console.log("DATA:", JSON.stringify(data, null, 2));
        } catch (err) {
            console.log("❌ Parse error:", err);
        }
    });

    watcher.onDidCreate(uri => {
        console.log("🟢 Created:", uri.fsPath);
    });

    watcher.onDidDelete(uri => {
        console.log("🔴 Deleted:", uri.fsPath);
    });

    context.subscriptions.push(watcher);
}

export function deactivate() {}