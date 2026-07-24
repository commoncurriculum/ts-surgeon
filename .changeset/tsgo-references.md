---
"@commoncurriculum/ts-surgeon": minor
---

Answer intercepted identifier searches with tsgo instead of ts-morph.

The guard answers a hunted identifier by looking up real references. Through
ts-morph that means parsing the project and loading its dependency type graph
on every call — ~1.2s on a real repo, and the cost is not the parse: a
two-file project with no dependencies resolves in 128ms, while narrowing a
real project to the two files that mention the symbol makes it *slower*,
because the checker still loads the `.d.ts` graph those files import.

tsgo (TypeScript 7, Go) answers the same question in ~250ms from a process
that starts, answers and exits. No daemon, no cache, nothing that can go
stale. On a compiled guard the whole answered search drops from ~1979ms to
~402ms.

Correctness is the point, so it is pinned rather than asserted:
`src/tsgo/find-references.test.ts` runs both engines over one real project and
compares location sets, including a symbol reachable only through an aliased
re-export — the case a text search structurally cannot see.

The subtlety is `workspace/symbol`, which is the editor's quick-open search:
fuzzy, scoped to the repository rather than the project, and it returns
duplicates. On a real repo, `lessonTitle` returned 15 hits from an unrelated
package. Taking the first would answer from an arbitrary same-named symbol —
so candidates are scoped to the project, deduplicated, and anything other than
exactly one declaration is reported instead of guessed at.
