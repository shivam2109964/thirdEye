import type { DartCallSite, DartParseResult } from './parser';

export type FunctionCall = {
    id: string;

    // function name (UserService.createUser)
    functionName: string;

    // NEW → object context
    objectName?: string; // userService
    className?: string; // UserService

    args: { param: string; value: string }[];
    returnValue?: string;

    children: FunctionCall[];
};

export type ExecutionTreeViewPayload = {
    entry?: string;
    root?: FunctionCall;
    symbols?: {
        files: string[];
        classes: string[];
        functions: string[];
        variables: string[];
    };
};

let callSeq = 0;

function nextId(prefix: string): string {
    callSeq += 1;
    return `${prefix}-${callSeq}`;
}

function subtreeForCallee(calleeName: string, byFrom: Map<string, DartCallSite[]>): FunctionCall[] {
    const sites = byFrom.get(calleeName) ?? [];

    return sites.map((site) => {
        const parts = site.to.split('.');

        return {
            id: nextId('call'),
            functionName: site.to,

            // NEW OOP INFO
            className: parts.length > 1 ? parts[0] : undefined,
            objectName: site.objectName,

            args: site.args ?? [],

            children: subtreeForCallee(site.to, byFrom),
        };
    });
}

export function buildExecutionTreeView(parse: DartParseResult): ExecutionTreeViewPayload {
    callSeq = 0;

    const calls = parse.calls ?? [];
    const byFrom = new Map<string, DartCallSite[]>();
    for (const c of calls) {
        const list = byFrom.get(c.from) ?? [];
        list.push(c);
        byFrom.set(c.from, list);
    }

    const entry = parse.functions?.includes('main')
        ? 'main'
        : parse.functions?.length
          ? parse.functions[0]
          : undefined;

    let root: FunctionCall | undefined;
    if (entry) {
        const parts = entry.split('.');
        root = {
            id: nextId('call'),
            functionName: entry,
            className: parts.length > 1 ? parts[0] : undefined,
            args: [],
            children: subtreeForCallee(entry, byFrom),
        };
    }

    const symbols = {
        files: [parse.file],
        classes: (parse.classes ?? []).map((c) => c.name),
        functions: [...(parse.functions ?? [])],
        variables: [...(parse.variables ?? [])],
    };

    return { entry, root, symbols };
}
