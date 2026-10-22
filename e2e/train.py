"""Train the xG model on the latest shots."""
import pandas as pd
from sklearn.linear_model import LogisticRegression


def train(path: str, c: float = 0.5) -> LogisticRegression:
    shots = pd.read_parquet(path)
    shots["header"] = (shots["body_part"] == "head").astype(int)
    model = LogisticRegression(C=c, max_iter=500)
    model.fit(shots[["distance", "angle", "header"]], shots["goal"])
    return model
