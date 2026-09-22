module.exports = {
    env: {
        commonjs: true,
        es2021: true,
        node: true,
    },
    parserOptions: {
        ecmaVersion: 12,
    },
    globals: {
        _: 'readonly',
        messages: 'readonly',
        log: 'readonly',
        emitter: 'readonly',
    },
    rules: {
        indent: [
            'error',
            4,
            {
                SwitchCase: 1,
                flatTernaryExpressions: true,
                ignoredNodes: ['ConditionalExpression'],
            },
        ],
        quotes: ['error', 'single'],
        semi: ['error', 'always'],
        'object-curly-spacing': ['error', 'always'], // Spaces in object
        'max-len': [
            'warn',
            {
                code: 80,
                ignoreUrls: true,
                ignoreStrings: true,
                ignoreComments: true,
                ignoreRegExpLiterals: true,
                ignoreTemplateLiterals: true,
                ignoreTrailingComments: true,
            },
        ],
        'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }], // Disallow unused variables, allowing function params and catch exceptions
        'no-cond-assign': ['error', 'always'], // Disallow assignment in conditional expressions such as if and loops
        'no-multi-spaces': 'error', // Disallow extra spaces between conditional expressions
        'no-throw-literal': 'error', // Disallow throwing literals as exceptions
        'block-spacing': 'error', // Disallow or enforce spaces inside of blocks after opening block and before closing block
        'brace-style': 'error', // Enforce consistent brace style for blocks
        camelcase: [
            'error',
            {
                properties: 'never',
                ignoreDestructuring: true,
                ignoreImports: true,
                ignoreGlobals: true,
            },
        ], // Enforce camelCase naming convention
        'comma-spacing': ['error', { before: false, after: true }], // Enforce consistent spacing before and after commas
        'comma-style': ['error', 'last'], // Enforce consistent comma style
        'func-call-spacing': ['error', 'never'], // Disallow spacing between function identifiers and their invocations
        'key-spacing': ['error', { beforeColon: false, afterColon: true }], // Enforce consistent spacing between keys and values in object literal properties
        'keyword-spacing': [
            'error',
            {
                overrides: {
                    if: { after: true },
                    for: { after: true },
                    while: { after: true },
                    static: { after: true },
                    as: { after: true },
                },
            },
        ], // Enforce consistent spacing before and after keywords
        'no-multiple-empty-lines': ['error', { max: 2, maxBOF: 1 }], // Disallow multiple empty lines
        'space-before-function-paren': [
            'error',
            {
                anonymous: 'always',
                named: 'never',
                asyncArrow: 'always',
            },
        ], // Enforce consistent spacing before function definition opening parenthesis
        'no-var': 'error', // Require let or const instead of var
        'prefer-const': ['error', { destructuring: 'all' }], // Require const declarations for variables that are never reassigned after declared
        'no-dupe-args': 'error', // Disallow duplicate arguments in function definitions
        'no-dupe-keys': 'error', // Disallow duplicate keys in object literals
        'for-direction': 'error', // Enforce "for" loop update clause moving the counter in the right direction
        'no-const-assign': 'error', // Disallow reassigning const variables
        'no-debugger': 'error',
        'no-dupe-else-if': 'error', // Disallow duplicate conditions in if-else-if chains
        'no-duplicate-case': 'error', // Disallow duplicate case labels
        'no-ex-assign': 'error', // Disallow reassigning exceptions in catch clauses
        'no-extra-boolean-cast': 'error', // Disallow unnecessary boolean casts
        'no-extra-semi': 'error', // Disallow unnecessary semicolons
        'no-fallthrough': 'error', // Disallow fallthrough of case statements
        'no-obj-calls': 'error', // Disallow calling global object properties as functions [Math, JSON, Reflect and Atomics]
        'no-shadow-restricted-names': 'error', // Disallow identifiers from shadowing restricted names
        'no-sparse-arrays': 'error', // Disallow sparse arrays
        'no-undef': 'error', // Disallow the use of undeclared variables unless mentioned in `global`
        'no-unreachable': 'error', // Disallow unreachable code after return, throw, continue, and break statements
        'no-unsafe-finally': 'error', // Disallow control flow statements in finally blocks [return, throw, break, or continue]
        'use-isnan': 'error', // Require calls to isNaN() when checking for NaN
        'valid-typeof': 'error', // Enforce comparing typeof expressions against valid strings ["undefined", "object", "boolean", "number", "string", "function", "symbol", and "bigint"]
        'no-console': ['error', { allow: ['warn', 'error'] }],
    },
};
