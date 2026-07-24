---
"@commoncurriculum/ts-surgeon": patch
---

Stop counting property reads as declarations.

`PropertyAccessExpression.getNameNode()` returns the identifier being read, so
every `styles.lessonTitle` looked like a declaration of `lessonTitle`. That was
invisible while the property had a resolvable symbol to dedupe on — but a
CSS-module import is typed as an index signature, so each read counted as its
own declaration. Symbol lookups then reported "N declarations; pass
targetFilePath to disambiguate", and passing one of those positions resolved to
nothing. The guard blocked the grep, demanded a disambiguation, and led nowhere.

Declaration lookups now ignore access syntax (`a.b`, `Outer.Inner`), and group
the remaining candidates by the declaration they ultimately stand for — so an
object-literal key contextually typed by an interface resolves to that
interface's property instead of rivalling it, and an overloaded function
resolves to its implementation.
