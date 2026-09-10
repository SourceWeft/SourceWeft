//! All coordinates are physical pixels, so mixed-DPI monitor origins stay valid.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn adjacent_position(main: Rect, work: Rect, width: f64, height: f64, gap: f64) -> (i32, i32) {
    let right = main.x + main.width + gap;
    let left = main.x - width - gap;
    let preferred_x = if right + width <= work.x + work.width {
        right
    } else if left >= work.x {
        left
    } else {
        // Neither side fits: overlap the main window's right edge, keeping
        // the companion nearby rather than jumping to the display origin.
        main.x + main.width - width - gap
    };
    let x = preferred_x
        .max(work.x)
        .min(work.x + (work.width - width).max(0.0));
    let y = main
        .y
        .max(work.y)
        .min(work.y + (work.height - height).max(0.0));
    (x.round() as i32, y.round() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    const WORK: Rect = Rect {
        x: 0.0,
        y: 25.0,
        width: 1920.0,
        height: 1055.0,
    };
    #[test]
    fn opens_beside_the_main_window_on_the_right() {
        assert_eq!(
            adjacent_position(
                Rect {
                    x: 80.0,
                    y: 100.0,
                    width: 1100.0,
                    height: 800.0
                },
                WORK,
                560.0,
                760.0,
                12.0
            ),
            (1192, 100)
        );
    }
    #[test]
    fn uses_the_left_when_the_right_does_not_fit() {
        assert_eq!(
            adjacent_position(
                Rect {
                    x: 800.0,
                    y: 120.0,
                    width: 1000.0,
                    height: 800.0
                },
                WORK,
                560.0,
                760.0,
                12.0
            ),
            (228, 120)
        );
    }
    #[test]
    fn overlaps_near_the_right_edge_when_neither_side_fits() {
        let work = Rect {
            width: 1440.0,
            ..WORK
        };
        assert_eq!(
            adjacent_position(
                Rect {
                    x: 80.0,
                    y: 90.0,
                    width: 1280.0,
                    height: 840.0
                },
                work,
                560.0,
                760.0,
                12.0
            ),
            (788, 90)
        );
    }
    #[test]
    fn stays_on_the_main_windows_negative_origin_monitor() {
        let work = Rect {
            x: -2560.0,
            y: -1200.0,
            width: 2560.0,
            height: 1440.0,
        };
        let (x, y) = adjacent_position(
            Rect {
                x: -2300.0,
                y: -1100.0,
                width: 1100.0,
                height: 800.0,
            },
            work,
            1120.0,
            1200.0,
            24.0,
        );
        assert_eq!((x, y), (-1176, -1100));
        assert!(x as f64 + 1120.0 <= work.x + work.width);
        assert!(y as f64 + 1200.0 <= work.y + work.height);
    }
    #[test]
    fn clamps_to_work_area_when_main_is_near_the_bottom_or_offscreen() {
        assert_eq!(
            adjacent_position(
                Rect {
                    x: -50.0,
                    y: 900.0,
                    width: 1000.0,
                    height: 800.0
                },
                WORK,
                560.0,
                760.0,
                12.0
            ),
            (962, 320)
        );
    }
}
