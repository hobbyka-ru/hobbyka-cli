# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy==2.2.6",
#   "pillow==11.3.0",
#   "torch==2.7.1",
#   "torchvision==0.22.1",
#   "timm==1.0.28",
# ]
# ///
"""Local SigLIP2-L index builder and exact cosine search for Hobbyka CLI."""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
import timm
from timm.data import create_transform, resolve_model_data_config

MODEL_ID = "timm/vit_large_patch16_siglip_384.v2_webli"
IMAGE_SIZE = 512
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024


def device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def download_image(url: str) -> Image.Image:
    if not url.startswith(("https://", "http://")):
        raise ValueError("unsupported image URL")
    request = urllib.request.Request(url, headers={"User-Agent": "hobbyka-cli-image-index/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        length = int(response.headers.get("Content-Length") or 0)
        if length > MAX_DOWNLOAD_BYTES:
            raise ValueError("image too large")
        data = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ValueError("image too large")
    return Image.open(io.BytesIO(data)).convert("RGB")


def load_model(source: str) -> tuple[torch.nn.Module, torch.device, object]:
    target = device()
    model = timm.create_model(f"hf_hub:{source}", pretrained=True, num_classes=0, img_size=IMAGE_SIZE).to(target).eval()
    data_config = resolve_model_data_config(model)
    data_config["input_size"] = (3, IMAGE_SIZE, IMAGE_SIZE)
    return model, target, create_transform(**data_config, is_training=False)


def embeddings(model: torch.nn.Module, target: torch.device, transform: object, images: list[Image.Image]) -> np.ndarray:
    with torch.inference_mode():
        output = model(torch.stack([transform(image.convert("RGB")) for image in images]).to(target))
        vectors = F.normalize(output.float(), dim=-1)
    return vectors.cpu().numpy()


def build(args: argparse.Namespace) -> dict:
    payload = json.load(sys.stdin)
    products = payload.get("products")
    if not isinstance(products, list) or not products:
        raise ValueError("Каталог для индекса пуст.")
    model, target, transform = load_model(args.model)
    batch_size = min(8, max(1, int(os.environ.get("HOBBYKA_VISION_BATCH_SIZE", "1"))))
    vectors: list[np.ndarray] = []
    product_ids: list[int] = []
    pending: list[Image.Image] = []
    pending_ids: list[int] = []
    failures = 0

    def flush() -> None:
        if not pending:
            return
        vectors.extend(embeddings(model, target, transform, pending))
        product_ids.extend(pending_ids)
        pending.clear()
        pending_ids.clear()

    for product in products:
        product_id = int(product["product_id"])
        for url in product.get("image_urls") or []:
            try:
                pending.append(download_image(url))
                pending_ids.append(product_id)
                if len(pending) >= batch_size:
                    flush()
            except Exception:
                failures += 1
    flush()
    if not vectors:
        raise ValueError("Не удалось извлечь ни одного изображения каталога.")
    matrix = np.asarray(vectors, dtype=np.float32)
    ids = np.asarray(product_ids, dtype=np.int64)
    Path(args.index).parent.mkdir(parents=True, exist_ok=True)
    np.savez(args.index, embeddings=matrix, product_ids=ids)
    return {
        "ok": True, "model": args.model, "device": str(target), "images": len(ids),
        "product_ids": sorted({int(value) for value in ids}), "download_failures": failures
    }


def search(args: argparse.Namespace) -> dict:
    archive = np.load(args.index, allow_pickle=False)
    matrix = archive["embeddings"].astype(np.float32, copy=False)
    product_ids = archive["product_ids"].astype(np.int64, copy=False)
    if matrix.ndim != 2 or len(matrix) != len(product_ids):
        raise ValueError("Индекс имеет неверный формат.")
    model, target, transform = load_model(args.model)
    query = embeddings(model, target, transform, [Image.open(args.image).convert("RGB")])[0]
    scores = matrix @ query
    best: dict[int, float] = {}
    for product_id, score in zip(product_ids, scores):
        best[int(product_id)] = max(best.get(int(product_id), float("-inf")), float(score))
    ranked = sorted(best.items(), key=lambda item: item[1], reverse=True)[: args.top_k]
    return {
        "ok": True, "model": args.model,
        "candidates": [{"product_id": product_id, "score": score} for product_id, score in ranked],
        "top1_margin": ranked[0][1] - ranked[1][1] if len(ranked) > 1 else 1.0,
    }


def main() -> dict:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    build_parser = subparsers.add_parser("build")
    build_parser.add_argument("--index", required=True)
    build_parser.add_argument("--model", default=os.environ.get("HOBBYKA_IMAGE_MODEL", MODEL_ID))
    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("--index", required=True)
    search_parser.add_argument("--image", required=True)
    search_parser.add_argument("--model", default=os.environ.get("HOBBYKA_IMAGE_MODEL", MODEL_ID))
    search_parser.add_argument("--top-k", type=int, default=20)
    args = parser.parse_args()
    return build(args) if args.command == "build" else search(args)


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as error:
    print(json.dumps({"ok": False, "error": {"code": "vision_failed", "message": str(error)}}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(1)
