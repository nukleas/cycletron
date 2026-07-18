use robostrudel_gen::factor;
use robostrudel_gen::mini::Mini;
use robostrudel_gen::verify::reproduces;

fn bars(v: &[&str]) -> Vec<Mini> { v.iter().map(|s| Mini::atom(*s)).collect() }

fn show(label: &str, names: &[&str]) {
    let b = bars(names);
    let naive = Mini::Alt(b.clone());
    let c = factor::compress(&b);
    let (n, cc) = factor::ratio(&b, &c);
    println!("{label}:");
    println!("  naive({n}):      {}", naive.emit());
    println!("  compressed({cc}): {}   [reproduces: {}]", c.emit(), reproduces(&b, &c));
    println!("  saved: {}%\n", if n>0 {100*(n-cc)/n} else {0});
}

fn main() {
    show("chord loop", &["c3","c3","e3","c3","c3","e3","c3","c3","e3"]);
    show("AABA phrase", &["a","a","b","a"]);
    show("static kick", &["bd","bd","bd","bd","bd","bd","bd","bd"]);
    show("through-composed", &["c","d","e","f","g"]);
    show("nested repeats", &["a","a","a","a","b","b","c"]);
}
