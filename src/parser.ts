import path from 'path';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

export type DartClass = {
    name: string;
    methods: string[];
    fields: string[];
};

export type DartCallSite = {
    from: string;
    to: string;
    args?: Array<{ param: string; value: string }>;
};

export type DartFunctionDef = {
    name: string;
    params: Array<{ name: string; type: string }>;
};

export type DartParseResult = {
    file: string;
    classes: DartClass[];
    functions: string[];
    variables: string[];
    imports: string[];
    calls: DartCallSite[];
    /** Top-level and `Class.method` signatures from static analysis. */
    functionDefs?: DartFunctionDef[];
    // Extra metadata emitted by the Dart parser (safe to ignore by consumers)
    variableScopes?: Array<{ name: string; parent: string; kind: string }>;
};

/** Thrown for `ok: false` from the Dart parser (same class of errors as a failed one-shot parse). */
export class DartParseUserError extends Error {
    readonly name = 'DartParseUserError';
}

type ServerResponse = { ok: true; result: DartParseResult } | { ok: false; error?: string };

let service: DartParseService | undefined;

export function disposeDartParseService(): void {
    service?.dispose();
    service = undefined;
}

function getDartParseService(extensionRootPath: string): DartParseService {
    if (!service || service.extensionRootPath !== extensionRootPath) {
        service?.dispose();
        service = new DartParseService(extensionRootPath);
    }
    return service;
}

/**
 * Parses a Dart file using a long-lived `dart run parser.dart --server` process when possible,
 * with one-shot `dart run parser.dart <path>` fallback if the server fails.
 */
export async function parseDartFile(filePath: string, extensionRootPath: string): Promise<DartParseResult> {
    return getDartParseService(extensionRootPath).parse(filePath);
}

class DartParseService {
    readonly extensionRootPath: string;
    private child: ChildProcessWithoutNullStreams | undefined;
    private rl: readline.Interface | undefined;
    private tail: Promise<void> = Promise.resolve();

    constructor(extensionRootPath: string) {
        this.extensionRootPath = extensionRootPath;
    }

    parse(filePath: string): Promise<DartParseResult> {
        const run = async (): Promise<DartParseResult> => {
            try {
                return await this.parseViaServer(filePath);
            } catch (e) {
                if (e instanceof DartParseUserError) {
                    throw e;
                }
                this.disposeChild();
                return this.parseViaOneShot(filePath);
            }
        };

        const p = new Promise<DartParseResult>((resolve, reject) => {
            this.tail = this.tail.then(() => run().then(resolve, reject));
        });
        return p;
    }

    dispose(): void {
        this.disposeChild();
    }

    private disposeChild(): void {
        this.rl?.close();
        this.rl = undefined;
        if (this.child && !this.child.killed) {
            this.child.kill();
        }
        this.child = undefined;
    }

    private async ensureServer(): Promise<void> {
        if (this.child && !this.child.killed && this.rl) {
            return;
        }

        this.disposeChild();

        const child = spawn('dart', ['run', 'parser.dart', '--server'], {
            cwd: this.extensionRootPath,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;

        this.rl = readline.createInterface({ input: child.stdout, terminal: false });

        child.stderr?.on('data', () => {
            /* analyzer may print to stderr; ignore unless debugging */
        });

        child.on('error', () => {
            this.disposeChild();
        });

        child.on('close', () => {
            if (this.child === child) {
                this.disposeChild();
            }
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    private readResponseLine(): Promise<string> {
        return new Promise((resolve, reject) => {
            const rl = this.rl;
            const child = this.child;
            if (!rl || !child) {
                reject(new Error('Dart parser server not running'));
                return;
            }

            const onLine = (line: string) => {
                cleanup();
                resolve(line);
            };
            const onClose = (code: number | null) => {
                cleanup();
                reject(new Error(`Dart parser process closed (${code ?? '?'})`));
            };

            const cleanup = () => {
                rl.removeListener('line', onLine);
                child.removeListener('close', onClose);
            };

            rl.once('line', onLine);
            child.once('close', onClose);
        });
    }

    private async parseViaServer(filePath: string): Promise<DartParseResult> {
        await this.ensureServer();

        const child = this.child;
        if (!child?.stdin) {
            throw new Error('Dart parser stdin unavailable');
        }

        child.stdin.write(`${JSON.stringify({ path: filePath })}\n`);

        const line = await this.readResponseLine();
        let msg: ServerResponse;
        try {
            msg = JSON.parse(line) as ServerResponse;
        } catch {
            throw new Error('Invalid JSON from Dart parser server');
        }

        if (!msg.ok) {
            throw new DartParseUserError(msg.error ?? 'Dart parse failed');
        }

        return msg.result;
    }

    private parseViaOneShot(filePath: string): DartParseResult {
        const scriptPath = path.join(this.extensionRootPath, 'parser.dart');
        const output = execFileSync('dart', [scriptPath, filePath], {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
        });
        return JSON.parse(output) as DartParseResult;
    }
}
