from .units import cm


class Circle:
    def __init__(self, r):
        self.r = r * cm


def filler_1(x):
    return x + 1

def filler_2(x):
    return x + 2

def filler_3(x):
    return x + 3

def filler_4(x):
    return x + 4

def filler_5(x):
    return x + 5

def filler_6(x):
    return x + 6

def filler_7(x):
    return x + 7

def filler_8(x):
    return x + 8


def ring(r):
    return Circle(r)
