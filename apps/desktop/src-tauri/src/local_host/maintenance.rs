use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    draining: bool,
    active: usize,
}
#[derive(Clone, Default)]
pub struct Admission(Arc<Mutex<State>>);
pub struct Lease(Admission);
pub struct Maintenance(Admission);
impl Admission {
    pub fn enter(&self) -> Result<Lease, &'static str> {
        let mut state = self.0.lock().map_err(|_| "HOST_UNAVAILABLE")?;
        if state.draining {
            return Err("HOST_UPDATING");
        }
        state.active += 1;
        Ok(Lease(self.clone()))
    }
    pub fn drain(&self) -> Result<Maintenance, &'static str> {
        let mut state = self.0.lock().map_err(|_| "HOST_UNAVAILABLE")?;
        if state.draining {
            return Err("HOST_UPDATING");
        }
        state.draining = true;
        Ok(Maintenance(self.clone()))
    }
}
impl Maintenance {
    pub fn idle(&self) -> bool {
        self.0 .0.lock().map(|s| s.active == 0).unwrap_or(false)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut s) = self.0 .0.lock() {
            s.active -= 1;
        }
    }
}
impl Drop for Maintenance {
    fn drop(&mut self) {
        if let Ok(mut s) = self.0 .0.lock() {
            s.draining = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drains_all_leases_without_cancelling_them_and_reopens_on_cancel() {
        let gate = Admission::default();
        let work = gate.enter().unwrap();
        let drain = gate.drain().unwrap();
        assert!(!drain.idle());
        assert!(gate.enter().is_err());
        drop(work);
        assert!(drain.idle());
        drop(drain);
        assert!(gate.enter().is_ok());
    }
    #[test]
    fn admission_and_maintenance_are_atomic() {
        for _ in 0..50 {
            let gate = Admission::default();
            let clone = gate.clone();
            let task = std::thread::spawn(move || clone.enter());
            let drain = gate.drain().unwrap();
            if let Ok(lease) = task.join().unwrap() {
                assert!(!drain.idle());
                drop(lease);
            }
            assert!(drain.idle());
            assert!(gate.enter().is_err());
        }
    }
}
