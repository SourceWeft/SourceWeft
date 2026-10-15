// A bounded adversarial fixture, not an unbounded fork bomb: <=4 child processes,
// three writer threads per child, <=10 seconds, inside a pids/memory-limited container.
use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Child, Command};
use std::time::{Duration, Instant};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    assert!(status.lines().any(|line| line.starts_with("Uid:") && line.split_whitespace().nth(1) == Some("65534")), "fixture must run as the isolated test workload UID");
    if args.get(1).map(String::as_str) == Some("writer") {
        let mut threads = Vec::new();
        for _ in 0..3 {
            threads.push(std::thread::spawn(|| {
                let end=Instant::now()+Duration::from_millis(80);
                while Instant::now()<end {
                    let mut file=OpenOptions::new().create(true).append(true).open("churn").unwrap();
                    file.write_all(b"dirty\n").unwrap();
                    std::thread::sleep(Duration::from_millis(1));
                }
            }));
        }
        for thread in threads {thread.join().unwrap();}
        return;
    }
    let executable=std::env::current_exe().unwrap();
    let end=Instant::now()+Duration::from_secs(10);
    let mut children:Vec<Child>=Vec::new();
    while Instant::now()<end {
        for index in (0..children.len()).rev() {
            if children[index].try_wait().unwrap().is_some() {children.swap_remove(index);}
        }
        while children.len()<4 {
            children.push(Command::new(&executable).arg("writer").spawn().unwrap());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    for mut child in children {child.wait().unwrap();}
}
