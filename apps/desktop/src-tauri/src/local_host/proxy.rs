//! Per-command HTTP CONNECT proxy. DNS resolution and destination validation happen
//! outside the command sandbox; the command can connect only to this listener.
use super::{HostError, Result};
use std::{
    io::{Read, Write},
    net::{IpAddr, Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

pub struct PublicProxy {
    pub port: u16,
    stopped: Arc<AtomicBool>,
}
impl Drop for PublicProxy {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}
impl PublicProxy {
    pub fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        std::thread::spawn(move || {
                            let _ = forward(socket);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self { port, stopped })
    }
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_address(IpAddr::V4(v4));
            }
            let first = ip.segments()[0];
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && (first & 0xfe00) != 0xfc00
                && (first & 0xffc0) != 0xfe80
                && (first & 0xe000) == 0x2000
                && !(first == 0x2001 && ip.segments()[1] == 0x0db8)
        }
    }
}

fn forward(mut client: TcpStream) -> Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(15)))?;
    client.set_write_timeout(Some(Duration::from_secs(15)))?;
    let mut header = Vec::new();
    let mut byte = [0];
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() > 16384 {
            return Err(HostError::new(
                "PROXY_HEADER_TOO_LARGE",
                "Proxy request rejected",
            ));
        }
        if client.read(&mut byte)? == 0 {
            return Ok(());
        }
        header.push(byte[0]);
    }
    let text = std::str::from_utf8(&header)
        .map_err(|_| HostError::new("PROXY_INVALID_REQUEST", "Invalid HTTP header"))?;
    let line = text.lines().next().unwrap_or("");
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3 {
        return Err(HostError::new(
            "PROXY_INVALID_REQUEST",
            "Invalid HTTP request",
        ));
    }
    let connect = parts[0] == "CONNECT";
    let url = url::Url::parse(&if connect {
        format!("https://{}", parts[1])
    } else {
        parts[1].into()
    })
    .map_err(|_| HostError::new("PROXY_INVALID_URL", "Invalid target"))?;
    if (!connect && url.scheme() != "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")?;
        return Ok(());
    }
    let host = url
        .host_str()
        .ok_or_else(|| HostError::new("PROXY_INVALID_URL", "Missing host"))?;
    let port = url.port_or_known_default().unwrap_or(0);
    let addresses: Vec<_> = (host, port).to_socket_addrs()?.collect();
    if ![80, 443].contains(&port)
        || addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !public_address(address.ip()))
    {
        client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")?;
        return Ok(());
    }
    // Connect to the exact address already checked; do not resolve the name again.
    let mut remote = TcpStream::connect_timeout(&addresses[0], Duration::from_secs(10))?;
    remote.set_read_timeout(Some(Duration::from_secs(15)))?;
    remote.set_write_timeout(Some(Duration::from_secs(15)))?;
    if connect {
        client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
    } else {
        let target = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        write!(remote, "{} {} HTTP/1.1\r\n", parts[0], target)?;
        for line in text.split("\r\n").skip(1).filter(|line| !line.is_empty()) {
            let name = line.split(':').next().unwrap_or("");
            if !["proxy-authorization", "proxy-connection", "connection"]
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
            {
                write!(remote, "{line}\r\n")?;
            }
        }
        remote.write_all(b"Connection: close\r\n\r\n")?;
    }
    let mut client_read = client.try_clone()?;
    let mut remote_write = remote.try_clone()?;
    let upload = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut remote_write);
        let _ = remote_write.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut remote, &mut client);
    let _ = client.shutdown(Shutdown::Both);
    let _ = remote.shutdown(Shutdown::Both);
    let _ = upload.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_metadata_and_mapped_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fd00::1",
            "2001:db8::1",
        ] {
            assert!(!public_address(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_address("1.1.1.1".parse().unwrap()));
    }
}
