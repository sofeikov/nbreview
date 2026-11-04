from shapes import ring
import navcheck.shapes as sh
from navcheck import (
    Circle,  # re-exported
    clamp,
)

print(ring(1), sh.ring(2), Circle(3), clamp(5, 0, 1))
