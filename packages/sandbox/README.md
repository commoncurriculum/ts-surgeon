# Sandbox Project for Refactoring Tool Testing

This directory contains a sample TypeScript project whose sole purpose is
testing and demonstrating the refactoring tools, in particular
those that perform code manipulation and refactoring via ts-morph.

**Purpose:**

*   **Isolated environment:** Provides a safe, isolated space for exercising
    refactoring tool operations without affecting the main tool codebase (`src/`).
*   **Demonstration:** Shows how the various tools work against a simple,
    representative project structure.
*   **Reproducibility:** Makes it easy to set up and reproduce specific
    scenarios for testing or debugging the tools.

**Structure:**

The `src/` directory contains example TypeScript modules (`moduleA.ts`,
`moduleB.ts`, `utils.ts`, etc.) with a variety of dependency patterns and
structures, designed to exercise different aspects of the refactoring tools.

**Usage:**

Use this sandbox project as the target when running tool commands
(e.g. `moveSymbolToFile`, `renameFileSystemEntry`) during development or
testing.

**Note:** This is not a functional application — it is a dedicated test bed.
