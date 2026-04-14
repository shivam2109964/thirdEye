import * as vscode from 'vscode';
import { parseJavaFile } from './parser';
import { buildExecutionTreeView } from './executionTree';
import { showExecutionTreePanel } from './webview/panel';

const PARSE_DEBOUNCE_MS = 250;

export function activate(context: vscode.ExtensionContext) {

    console.log('🔥 ThirdEye Activated (Java Mode)');

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        console.log('⚠️ No workspace folder is open. File watcher will not receive events until you open a folder/workspace.');
        return;
    }

    // Only watch Java sources.
    const pattern = new vscode.RelativePattern(folder, '**/*.java');
    console.log('Watching workspace folder:', folder.uri.fsPath);
    console.log('Watcher glob pattern:', pattern.pattern);

    // Explicitly set ignore flags to false (i.e., DO NOT ignore events).
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    console.log('Watcher created');
    console.log('⏳ ThirdEye: waiting for java file changes…');

    const debounceTimers = new Map<string, NodeJS.Timeout>();

    async function runParseGraph(javaPath: string): Promise<void> {
        console.log('⏳ ThirdEye: loading (read + parse + graph)…', javaPath);
        const wf = vscode.workspace.workspaceFolders?.[0];
        if (!wf) {
            return;
        }
        try {
            const data = await parseJavaFile(javaPath);
            const tree = buildExecutionTreeView(data);
            showExecutionTreePanel(context, tree);
            console.log('✅ ThirdEye: loading finished — execution tree panel updated');
        } catch (err) {
            console.log('❌ ThirdEye: loading failed — parse error:', err);
        }
    }

    function scheduleParse(javaPath: string): void {
        const prev = debounceTimers.get(javaPath);
        if (prev) {
            clearTimeout(prev);
        }
        debounceTimers.set(
            javaPath,
            setTimeout(() => {
                debounceTimers.delete(javaPath);
                void runParseGraph(javaPath);
            }, PARSE_DEBOUNCE_MS),
        );
    }

    context.subscriptions.push(
        { dispose: () => {
            for (const t of debounceTimers.values()) {
                clearTimeout(t);
            }
            debounceTimers.clear();
        } },
        watcher,
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.uri.fsPath.endsWith('.java')) {
                scheduleParse(doc.uri.fsPath);
            }
        }),
        watcher.onDidChange((uri) => {
            if (!uri.fsPath.endsWith('.java')) {
                return;
            }
            scheduleParse(uri.fsPath);
        })
    );
}

export function deactivate() {
    // cleanup if needed
}