# hap-ingest

JS-strudel → hap IR → `cycletron-gen::Mini` → strudel-rs.

Bakery files are web-strudel JS. Rather than rewriting that source, evaluate
it with the JS engine, treat the discrete haps as an intermediate, and lower
each voice onto the same `Mini` AST the generators emit. `factor::compress`
folds repeated bars. Output is a document `validate_doc` will accept.

```
cargo run -p hap-ingest -- corpus/_examples/featured/acidic-tooth--….strudel
cargo run -p hap-ingest -- --dir corpus/_examples/featured --limit 20
```

Defaults: 32 cycles, 16-step grid, one bar per line inside a slowcat.
Writes per-voice snippets (and a `$:` stack when two or more voices validate)
to `corpus/_examples/extracted/`.

First-time JS deps: `cd tools/hap-ingest && npm install`.
