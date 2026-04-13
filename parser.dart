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

class _CallEdge {
  _CallEdge({required this.from, required this.to});
  final String from;
  final String to;

  Map<String, Object?> toJson() => <String, Object?>{
        'from': from,
        'to': to,
      };
}

class _AstCollector extends RecursiveAstVisitor<void> {
  _AstCollector({
    required this.fileName,
    required Set<String> knownTopLevelFunctions,
    required Map<String, Set<String>> knownClassMethods,
  })  : _knownTopLevelFunctions = knownTopLevelFunctions,
        _knownClassMethods = knownClassMethods;

  final String fileName;

  final Set<String> _knownTopLevelFunctions;
  final Map<String, Set<String>> _knownClassMethods;

  final Set<String> imports = <String>{};
  final Map<String, _ClassInfo> classes = <String, _ClassInfo>{};
  final Set<String> topLevelFunctions = <String>{};
  final Set<String> variables = <String>{};
  final List<_VariableScope> variableScopes = <_VariableScope>[];
  final List<_CallEdge> calls = <_CallEdge>[];

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

  void _recordCall(String from, String to) {
    if (from.isEmpty || to.isEmpty) return;
    calls.add(_CallEdge(from: from, to: to));
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
        _recordCall(from, resolvedTo);
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
        _recordCall(from, calleeExpr.name);
      }
    }
    super.visitFunctionExpressionInvocation(node);
  }
}

class _PreCollector extends RecursiveAstVisitor<void> {
  _PreCollector();

  final Set<String> topLevelFunctions = <String>{};
  final Map<String, Set<String>> classMethods = <String, Set<String>>{};

  @override
  void visitFunctionDeclaration(FunctionDeclaration node) {
    if (!node.isGetter && !node.isSetter) {
      topLevelFunctions.add(node.name.lexeme);
    }
    super.visitFunctionDeclaration(node);
  }

  @override
  void visitClassDeclaration(ClassDeclaration node) {
    final className = node.namePart.typeName.lexeme;
    final methods = classMethods.putIfAbsent(className, () => <String>{});

    // Pre-scan members so calls to methods declared later still resolve.
    for (final member in node.body.members) {
      if (member is MethodDeclaration) {
        if (!member.isGetter && !member.isSetter) {
          methods.add(member.name.lexeme);
        }
      }
    }

    super.visitClassDeclaration(node);
  }
}

void main(List<String> args) {
  if (args.isEmpty) {
    stderr.writeln('Usage: dart parser.dart <path-to-dart-file>');
    exitCode = 2;
    return;
  }

  final filePath = args[0];
  final file = File(filePath);
  if (!file.existsSync()) {
    stderr.writeln('File not found: $filePath');
    exitCode = 2;
    return;
  }

  final content = file.readAsStringSync();
  final fileName = _basename(filePath);

  final parsed = parseString(
    content: content,
    path: filePath,
    throwIfDiagnostics: false,
  );

  final pre = _PreCollector();
  parsed.unit.accept(pre);

  final collector = _AstCollector(
    fileName: fileName,
    knownTopLevelFunctions: pre.topLevelFunctions,
    knownClassMethods: pre.classMethods,
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

  final seenCalls = <String>{};
  final callsOut = <Map<String, Object?>>[];
  for (final c in collector.calls) {
    final key = '${c.from}→${c.to}';
    if (seenCalls.add(key)) {
      callsOut.add(c.toJson());
    }
  }

  final out = <String, Object?>{
    'file': fileName,
    'classes': classesOut,
    'functions': functionsOut,
    'variables': variablesOut,
    'imports': importsOut,
    'calls': callsOut,

    // Extra metadata for correct hierarchy + symbol table in TS normalizer.
    'variableScopes': collector.variableScopes.map((v) => v.toJson()).toList(),
  };

  stdout.write(jsonEncode(out));
}

