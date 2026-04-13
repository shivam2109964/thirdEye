import * as vscode from 'vscode';
import { parseFile } from './parser';

export function activate(context: vscode.ExtensionContext) {

    console.log('🔥 ThirdEye Activated');

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        console.log('⚠️ No workspace folder is open. File watcher will not receive events until you open a folder/workspace.');
        return;
    }

    const pattern = new vscode.RelativePattern(folder, '**/*');
    console.log('Watching workspace folder:', folder.uri.fsPath);
    console.log('Watcher glob pattern:', pattern.pattern);

    // Explicitly set ignore flags to false (i.e., DO NOT ignore events).
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    console.log('Watcher created');

    context.subscriptions.push(
        watcher,
        vscode.workspace.onDidCreateFiles((e) => {
            for (const f of e.files) {
                console.log('🧩 onDidCreateFiles:', f.scheme, f.fsPath);
            }
        }),
        vscode.workspace.onDidDeleteFiles((e) => {
            for (const f of e.files) {
                console.log('🧩 onDidDeleteFiles:', f.scheme, f.fsPath);
            }
        }),
        vscode.workspace.onDidRenameFiles((e) => {
            for (const f of e.files) {
                console.log('🧩 onDidRenameFiles:', f.oldUri.fsPath, '->', f.newUri.fsPath);
            }
        }),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            console.log('🧩 onDidSaveTextDocument:', doc.uri.scheme, doc.uri.fsPath);
        }),
        watcher.onDidCreate((uri) => {
            console.log('🟢 watcher.onDidCreate:', uri.scheme, uri.fsPath);
        }),
        watcher.onDidChange((uri) => {
            console.log('🟡 watcher.onDidChange:', uri.scheme, uri.fsPath);

            try {
                const data = parseFile(uri.fsPath);
                console.log('DATA:', JSON.stringify(data, null, 2));
            } catch (err) {
                console.log('❌ Parse error:', err);
            }
        }),
        watcher.onDidDelete((uri) => {
            console.log('🔴 watcher.onDidDelete:', uri.scheme, uri.fsPath);
        }),
    );
}

export function deactivate() { }