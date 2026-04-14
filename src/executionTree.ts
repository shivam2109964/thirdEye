import type { JavaCallSite, ParseResult } from './parser';

import {
    buildCallGraph,
    dfs,
    bfs,
    detectCycles,
    findMissingDefinitions,
} from './core/callGraphEngine';

export type FunctionCall = {
    id: string;
    functionName: string;

    nodeType?: 'function' | 'endpoint' | 'service' | 'repository' | 'lifecycle';

    trigger?: string; // e.g. @GetMapping("/api")

    objectName?: string; // e.g. userService
    className?: string; // e.g. UserService

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

function determineNodeType(className: string | undefined, annotations: string[], functionName: string): 'function' | 'endpoint' | 'service' | 'repository' | 'lifecycle' {
    const isEndpoint = annotations.some(a => a.includes('Mapping'));
    if (isEndpoint) return 'endpoint';

    if (annotations.some(a => a.includes('PostConstruct') || a.includes('EventListener'))) {
        return 'lifecycle';
    }

    if (className) {
        if (className.endsWith('Controller')) return 'endpoint';
        if (className.endsWith('Service')) return 'service';
        if (className.endsWith('Repository') || className.endsWith('Dao')) return 'repository';
    }
    
    return 'function';
}

function extractTrigger(annotations: string[]): string | undefined {
    const mapping = annotations.find(a => a.includes('Mapping'));
    return mapping ? mapping : undefined; 
}

function subtreeForCallee(
    calleeName: string, 
    byFrom: Map<string, JavaCallSite[]>,
    parse: ParseResult
): FunctionCall[] {
    let sites = byFrom.get(calleeName) || [];
    if (sites.length === 0) {
        for (const [key, val] of byFrom.entries()) {
            if (key.endsWith('.' + calleeName)) {
                sites = val;
                break;
            }
        }
    }

    return sites.map((site) => {
        const parts = site.to.split('.');
        let className = parts.length > 1 ? parts[0] : 'Unknown';
        const methodOnly = parts.length > 1 ? parts[1] : parts[0];

        // Find function def to extract annotations
        let def = parse.functionDefs?.find(d => d.name === site.to);
        if (!def) {
            def = parse.functionDefs?.find(d => d.name.endsWith('.' + site.to));
        }
        
        let cls = parse.classes?.find(c => c.name === className);
        if (className === 'Unknown') {
            if (def) {
                className = def.name.split('.')[0];
                cls = parse.classes?.find(c => c.name === className);
            } else {
                // If it's an external library call with no definition (like System.out.println), leave className empty
                // so it doesn't render as "Unknown.println"
                className = undefined as any; 
            }
        }
        
        let ann = def?.annotations ?? [];
        if (cls) ann = ann.concat(cls.annotations);

        const nodeType = determineNodeType(className, ann, methodOnly);
        const trigger = extractTrigger(ann);

        return {
            id: nextId('call'),
            functionName: site.to,

            nodeType,
            trigger,

            className: className,
            objectName: site.objectName,

            args: site.args ?? [],

            children: subtreeForCallee(site.to, byFrom, parse),
        };
    });
}

function findEntryPoints(parse: ParseResult): { rootClass: string, methods: string[] }[] {
    const endpoints: { rootClass: string, methods: string[] }[] = [];

    for (const cls of parse.classes) {
        if (cls.annotations.some(a => a.includes('RestController') || a.includes('Controller') || a.includes('SpringBootApplication'))) {
            const entryMethods = parse.functionDefs?.filter(f => f.name.startsWith(cls.name + '.') && f.annotations.some(a => a.includes('Mapping') || a.includes('Command'))) ?? [];
            if (entryMethods.length > 0) {
                endpoints.push({ rootClass: cls.name, methods: entryMethods.map(m => m.name) });
            } else if (cls.annotations.some(a => a.includes('SpringBootApplication'))) {
                const mainMethod = parse.functionDefs?.find(f => f.name === `${cls.name}.main`);
                if (mainMethod) endpoints.push({ rootClass: cls.name, methods: [mainMethod.name] });
            }
        }
    }

    return endpoints;
}

export function buildExecutionTreeView(parse: ParseResult): ExecutionTreeViewPayload {
    callSeq = 0;

    const calls = parse.calls ?? [];
    
    // Spring Boot usually has multiple endpoints, we can create a synthetic root that connects to them all
    const entryPoints = findEntryPoints(parse);

    const graph = buildCallGraph(calls);

    const byFrom = new Map<string, JavaCallSite[]>();
    for (const c of calls) {
        const list = byFrom.get(c.from) ?? [];
        list.push(c);
        byFrom.set(c.from, list);
    }
    
    let root: FunctionCall | undefined;

    if (entryPoints.length > 0) {
        const children: FunctionCall[] = [];
        
        for (const ep of entryPoints) {
            for (const method of ep.methods) {
                // Find definition
                const def = parse.functionDefs?.find(d => d.name === method);
                const cls = parse.classes?.find(c => c.name === ep.rootClass);
                let ann = def?.annotations ?? [];
                if (cls) ann = ann.concat(cls.annotations);

                const nodeType = determineNodeType(ep.rootClass, ann, method);
                const trigger = extractTrigger(ann);

                children.push({
                    id: nextId('call'),
                    functionName: method,
                    className: ep.rootClass,
                    nodeType,
                    trigger,
                    args: [],
                    children: subtreeForCallee(method, byFrom, parse),
                });
            }
        }

        root = {
            id: nextId('synthetic-root'),
            functionName: 'Spring Boot Application Context',
            nodeType: 'lifecycle',
            args: [],
            children,
        };
    } else if (parse.functions.length > 0) {
        // Fallback for non-spring java files
        const entry = parse.functions[0];
        const parts = entry.split('.');
        root = {
            id: nextId('call'),
            functionName: entry,
            className: parts.length > 1 ? parts[0] : undefined,
            args: [],
            children: subtreeForCallee(entry, byFrom, parse),
        };
    }

    const symbols = {
        files: [parse.file],
        classes: parse.classes.map((c) => c.name),
        functions: parse.functions,
        variables: parse.variables,
    };

    return {
        entry: root?.functionName,
        root,
        symbols: {
            ...symbols,
        } as any,
    };
}
