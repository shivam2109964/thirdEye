import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';

String _basename(String path) {
  final normalized = path.replaceAll('\\', '/');
  final parts = normalized.split('/');
  return parts.isEmpty ? path : parts.last;
}

class _ClassInfo {
  _ClassInfo(this.name);
  final String name;
  final Set<String> methods = <String>{};
  final Set<String> fields = <String>{};
}

class _VariableScope {
  _VariableScope({
    required this.name,
    required this.parent,
    required this.kind,
  });

  final String name;
  final String parent;
  final String kind;

  Map<String, Object?> toJson() => <String, Object?>{
        'name': name,
        'parent': parent,
        'kind': kind,
      };
}

class _CallSite {
  _CallSite({
    required this.from,
    required this.to,
    required this.args,
  });
  final String from;
  final String to;
  final List<Map<String, String>> args;

  Map<String, Object?> toJson() => <String, Object?>{
        'from': from,
        'to': to,
        'args': args,
      };
}

class _AstCollector extends RecursiveAstVisitor<void> {
  _AstCollector({
    required this.fileName,
    required this.source,
    required Set<String> knownTopLevelFunctions,
    required Map<String, Set<String>> knownClassMethods,
    required Map<String, List<Map<String, String>>> signatures,
  })  : _knownTopLevelFunctions = knownTopLevelFunctions,
        _knownClassMethods = knownClassMethods,
        _signatures = signatures;

  final String fileName;
  final String source;

  final Set<String> _knownTopLevelFunctions;
  final Map<String, Set<String>> _knownClassMethods;
  final Map<String, List<Map<String, String>>> _signatures;

  final Set<String> imports = <String>{};
  final Map<String, _ClassInfo> classes = <String, _ClassInfo>{};
  final Set<String> topLevelFunctions = <String>{};
  final Set<String> variables = <String>{};
  final List<_VariableScope> variableScopes = <_VariableScope>[];
  final List<_CallSite> calls = <_CallSite>[];

  final List<String> _functionStack = <String>[];
  final List<String> _classStack = <String>[];

  String get _fileParent => 'file:$fileName';

  String? get _currentClass => _classStack.isEmpty ? null : _classStack.last;

  String? get _currentFunction =>
      _functionStack.isEmpty ? null : _functionStack.last;

  void _recordVariable(
    String name, {
    required String parent,
    required String kind,
  }) {
    if (name.isEmpty) return;
    variables.add(name);
    variableScopes.add(_VariableScope(name: name, parent: parent, kind: kind));
  }

  String _snippet(AstNode node) {
    final s = source;
    if (node.offset < 0 || node.end > s.length) {
      return '?';
    }
    return s.substring(node.offset, node.end).trim();
  }

  List<Map<String, String>> _bindingsForInvocation(
    String resolvedCallee,
    MethodInvocation node,
  ) {
    final sig = _signatures[resolvedCallee];
    final out = <Map<String, String>>[];
    var pos = 0;
    for (final arg in node.argumentList.arguments) {
      if (arg is NamedExpression) {
        final name = arg.name.label.name;
        out.add(<String, String>{
          'param': name,
          'value': _snippet(arg.expression),
        });
      } else if (arg is Expression) {
        String pname;
        if (sig != null && pos < sig.length) {
          pname = sig[pos]['name'] ?? '\$$pos';
        } else {
          pname = '\$$pos';
        }
        out.add(<String, String>{
          'param': pname,
          'value': _snippet(arg),
        });
        pos++;
      }
    }
    return out;
  }

  void _recordCall(String from, String to, MethodInvocation node) {
    if (from.isEmpty || to.isEmpty) return;
    final args = _bindingsForInvocation(to, node);
    calls.add(_CallSite(from: from, to: to, args: args));
  }

  void _recordCallSimple(String from, String to, FunctionExpressionInvocation node) {
    if (from.isEmpty || to.isEmpty) return;
    final out = <Map<String, String>>[];
    var i = 0;
    for (final arg in node.argumentList.arguments) {
      if (arg is Expression) {
        out.add(<String, String>{
          'param': '\$$i',
          'value': _snippet(arg),
        });
        i++;
      }
    }
    calls.add(_CallSite(from: from, to: to, args: out));
  }

  @override
  void visitImportDirective(ImportDirective node) {
    final uri = node.uri.stringValue;
    if (uri != null && uri.isNotEmpty) {
      imports.add(uri);
    }
    super.visitImportDirective(node);
  }

  @override
  void visitClassDeclaration(ClassDeclaration node) {
    final name = node.namePart.typeName.lexeme;
    classes.putIfAbsent(name, () => _ClassInfo(name));
    _classStack.add(name);
    super.visitClassDeclaration(node);
    _classStack.removeLast();
  }

  @override
  void visitFieldDeclaration(FieldDeclaration node) {
    final cls = _currentClass;
    if (cls == null) {
      super.visitFieldDeclaration(node);
      return;
    }

    final info = classes.putIfAbsent(cls, () => _ClassInfo(cls));
    for (final v in node.fields.variables) {
      final name = v.name.lexeme;
      info.fields.add(name);
      _recordVariable(name, parent: 'class:$cls', kind: 'field');
    }
    super.visitFieldDeclaration(node);
  }

  @override
  void visitMethodDeclaration(MethodDeclaration node) {
    final cls = _currentClass;
    if (cls == null) {
      super.visitMethodDeclaration(node);
      return;
    }

    // Avoid treating getters/setters (properties) as functions.
    if (node.isGetter || node.isSetter) {
      super.visitMethodDeclaration(node);
      return;
    }

    final name = node.name.lexeme;
    final info = classes.putIfAbsent(cls, () => _ClassInfo(cls));
    info.methods.add(name);

    final qualified = '$cls.$name';
    _functionStack.add(qualified);

    final params = node.parameters?.parameters ?? const <FormalParameter>[];
    for (final p in params) {
      final pName = p.name?.lexeme;
      if (pName != null && pName.isNotEmpty) {
        _recordVariable(pName, parent: 'function:$qualified', kind: 'parameter');
      }
    }

    super.visitMethodDeclaration(node);
    _functionStack.removeLast();
  }

  @override
  void visitFunctionDeclaration(FunctionDeclaration node) {
    // Only real functions; exclude getters/setters.
    if (node.isGetter || node.isSetter) {
      super.visitFunctionDeclaration(node);
      return;
    }

    final name = node.name.lexeme;
    topLevelFunctions.add(name);

    _functionStack.add(name);

    final params = node.functionExpression.parameters?.parameters ??
        const <FormalParameter>[];
    for (final p in params) {
      final pName = p.name?.lexeme;
      if (pName != null && pName.isNotEmpty) {
        _recordVariable(pName, parent: 'function:$name', kind: 'parameter');
      }
    }

    super.visitFunctionDeclaration(node);
    _functionStack.removeLast();
  }

  @override
  void visitTopLevelVariableDeclaration(TopLevelVariableDeclaration node) {
    for (final v in node.variables.variables) {
      final name = v.name.lexeme;
      _recordVariable(name, parent: _fileParent, kind: 'topLevel');
    }
    super.visitTopLevelVariableDeclaration(node);
  }

  @override
  void visitVariableDeclarationStatement(VariableDeclarationStatement node) {
    final fn = _currentFunction;
    final parent = fn == null ? _fileParent : 'function:$fn';
    for (final v in node.variables.variables) {
      final name = v.name.lexeme;
      _recordVariable(name, parent: parent, kind: 'local');
    }
    super.visitVariableDeclarationStatement(node);
  }

  @override
  void visitMethodInvocation(MethodInvocation node) {
    final from = _currentFunction;
    if (from != null) {
      final rawTo = node.methodName.name;

      // Resolve within-file symbol when possible.
      String resolvedTo = rawTo;

      final cls = _currentClass;
      if (cls != null) {
        final methods = _knownClassMethods[cls];
        if (methods != null && methods.contains(rawTo)) {
          resolvedTo = '$cls.$rawTo';
        }
      }

      if (_knownTopLevelFunctions.contains(rawTo)) {
        resolvedTo = rawTo;
      }

      final isKnownTopLevel = _knownTopLevelFunctions.contains(resolvedTo);
      final isKnownQualifiedMethod =
          resolvedTo.contains('.') &&
              _knownClassMethods[resolvedTo.split('.').first]
                      ?.contains(resolvedTo.split('.').last) ==
                  true;

      if (isKnownTopLevel || isKnownQualifiedMethod) {
        _recordCall(from, resolvedTo, node);
      }
    }
    super.visitMethodInvocation(node);
  }

  @override
  void visitFunctionExpressionInvocation(FunctionExpressionInvocation node) {
    final from = _currentFunction;
    if (from != null) {
      final calleeExpr = node.function;
      if (calleeExpr is SimpleIdentifier) {
        _recordCallSimple(from, calleeExpr.name, node);
      }
    }
    super.visitFunctionExpressionInvocation(node);
  }
}

class _DeclCollector extends RecursiveAstVisitor<void> {
  _DeclCollector(this.source);

  final String source;

  final Set<String> topLevelFunctions = <String>{};
  final Map<String, Set<String>> classMethods = <String, Set<String>>{};
  /// Top-level `foo` or `Class.method` → ordered parameter name/type pairs.
  final Map<String, List<Map<String, String>>> signatures =
      <String, List<Map<String, String>>>{};

  final List<String> _classStack = <String>[];

  String _typeForParam(FormalParameter p) {
    if (p is DefaultFormalParameter) {
      return _typeForParam(p.parameter);
    }
    if (p is SimpleFormalParameter) {
      final t = p.type;
      if (t == null) {
        return 'dynamic';
      }
      if (t.offset >= 0 && t.end <= source.length) {
        return source.substring(t.offset, t.end).trim();
      }
      return t.toString();
    }
    return 'dynamic';
  }

  String _nameForParam(FormalParameter p) {
    if (p is DefaultFormalParameter) {
      return _nameForParam(p.parameter);
    }
    if (p is SimpleFormalParameter) {
      return p.name?.lexeme ?? '';
    }
    return '';
  }

  List<Map<String, String>> _collectParams(FormalParameterList? list) {
    if (list == null) {
      return <Map<String, String>>[];
    }
    final out = <Map<String, String>>[];
    for (final fp in list.parameters) {
      final n = _nameForParam(fp);
      if (n.isEmpty) {
        continue;
      }
      out.add(<String, String>{
        'name': n,
        'type': _typeForParam(fp),
      });
    }
    return out;
  }

  @override
  void visitFunctionDeclaration(FunctionDeclaration node) {
    if (!node.isGetter && !node.isSetter) {
      final name = node.name.lexeme;
      topLevelFunctions.add(name);
      signatures[name] = _collectParams(node.functionExpression.parameters);
    }
    super.visitFunctionDeclaration(node);
  }

  @override
  void visitClassDeclaration(ClassDeclaration node) {
    final className = node.namePart.typeName.lexeme;
    final methods = classMethods.putIfAbsent(className, () => <String>{});

    for (final member in node.body.members) {
      if (member is MethodDeclaration) {
        if (!member.isGetter && !member.isSetter) {
          methods.add(member.name.lexeme);
        }
      }
    }

    _classStack.add(className);
    super.visitClassDeclaration(node);
    _classStack.removeLast();
  }

  @override
  void visitMethodDeclaration(MethodDeclaration node) {
    final cls = _classStack.isEmpty ? null : _classStack.last;
    if (cls != null && !node.isGetter && !node.isSetter) {
      final qualified = '$cls.${node.name.lexeme}';
      signatures[qualified] = _collectParams(node.parameters);
    }
    super.visitMethodDeclaration(node);
  }
}

Map<String, Object?> _parseDartFileToMap(String filePath) {
  final file = File(filePath);
  if (!file.existsSync()) {
    throw StateError('File not found: $filePath');
  }

  final content = file.readAsStringSync();
  final fileName = _basename(filePath);

  final parsed = parseString(
    content: content,
    path: filePath,
    throwIfDiagnostics: false,
  );

  final pre = _DeclCollector(content);
  parsed.unit.accept(pre);

  final collector = _AstCollector(
    fileName: fileName,
    source: content,
    knownTopLevelFunctions: pre.topLevelFunctions,
    knownClassMethods: pre.classMethods,
    signatures: Map<String, List<Map<String, String>>>.from(pre.signatures),
  );
  parsed.unit.accept(collector);

  final classList = collector.classes.values.toList()
    ..sort((a, b) => a.name.compareTo(b.name));

  final classesOut = classList
      .map((c) => <String, Object?>{
            'name': c.name,
            'methods': (c.methods.toList()..sort()),
            'fields': (c.fields.toList()..sort()),
          })
      .toList();

  final functionsOut = collector.topLevelFunctions.toList()..sort();
  final importsOut = collector.imports.toList()..sort();
  final variablesOut = collector.variables.toList()..sort();

  final callsOut = collector.calls.map((c) => c.toJson()).toList();

  final functionDefsOut = <Map<String, Object?>>[];
  for (final e in pre.signatures.entries) {
    functionDefsOut.add(<String, Object?>{
      'name': e.key,
      'params': e.value
          .map(
            (p) => <String, Object?>{
              'name': p['name'],
              'type': p['type'],
            },
          )
          .toList(),
    });
  }
  functionDefsOut.sort(
    (a, b) => (a['name'] as String).compareTo(b['name'] as String),
  );

  return <String, Object?>{
    'file': fileName,
    'classes': classesOut,
    'functions': functionsOut,
    'variables': variablesOut,
    'imports': importsOut,
    'calls': callsOut,
    'functionDefs': functionDefsOut,

    // Extra metadata for correct hierarchy + symbol table in TS normalizer.
    'variableScopes': collector.variableScopes.map((v) => v.toJson()).toList(),
  };
}

/// One JSON object per line: `{"ok":true,"result":{...}}` or `{"ok":false,"error":"..."}`.
void _runServer() {
  while (true) {
    final line = stdin.readLineSync(encoding: utf8);
    if (line == null) {
      return;
    }
    final trimmed = line.trim();
    if (trimmed.isEmpty) {
      continue;
    }

    Object? decoded;
    try {
      decoded = jsonDecode(trimmed);
    } catch (_) {
      stdout.writeln(jsonEncode(<String, Object?>{'ok': false, 'error': 'Invalid JSON request'}));
      continue;
    }

    if (decoded is! Map) {
      stdout.writeln(jsonEncode(<String, Object?>{'ok': false, 'error': 'Expected JSON object'}));
      continue;
    }

    final pathRaw = decoded['path'];
    if (pathRaw is! String || pathRaw.isEmpty) {
      stdout.writeln(jsonEncode(<String, Object?>{'ok': false, 'error': 'Missing path'}));
      continue;
    }

    try {
      final result = _parseDartFileToMap(pathRaw);
      stdout.writeln(jsonEncode(<String, Object?>{'ok': true, 'result': result}));
    } catch (e) {
      stdout.writeln(jsonEncode(<String, Object?>{'ok': false, 'error': e.toString()}));
    }
  }
}

void main(List<String> args) {
  if (args.length == 1 && args[0] == '--server') {
    _runServer();
    return;
  }

  if (args.isEmpty) {
    stderr.writeln('Usage: dart parser.dart <path-to-dart-file>');
    stderr.writeln('   or: dart parser.dart --server');
    exitCode = 2;
    return;
  }

  final filePath = args[0];
  try {
    final out = _parseDartFileToMap(filePath);
    stdout.write(jsonEncode(out));
  } catch (e) {
    stderr.writeln(e.toString());
    exitCode = 2;
  }
}

