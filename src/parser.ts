import path from 'path';
import { execFileSync } from 'child_process';

export type DartClass = {
    name: string;
    methods: string[];
    fields: string[];
};

export type DartParseResult = {
    file: string;
    classes: DartClass[];
    functions: string[];
    variables: string[];
    imports: string[];
    calls: Array<{ from: string; to: string }>;
    // Extra metadata emitted by the Dart parser (safe to ignore by consumers)
    variableScopes?: Array<{ name: string; parent: string; kind: string }>;
};

export function parseDartFile(filePath: string, extensionRootPath: string): DartParseResult {
    const scriptPath = path.join(extensionRootPath, 'parser.dart');

    const output = execFileSync('dart', [scriptPath, filePath], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
    });

    return JSON.parse(output) as DartParseResult;
}