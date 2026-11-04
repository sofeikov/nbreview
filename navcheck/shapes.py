from .units import cm


class Circle:
    def __init__(self, r):
        self.r = r * cm


def ring(r):
    return Circle(r)
