import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

    console.log('🔥 ThirdEye Activated');

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    watcher.onDidChange(uri => {
        console.log("🟡 Changed:", uri.fsPath);
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