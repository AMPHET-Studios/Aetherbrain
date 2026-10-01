"""
A tiny stand-in for Xenova/clip-vit-base-patch32, for tests only: the same
file names, inputs and outputs as the real model (transformers.js loads it the
same way), a few kilobytes instead of 150 MB. Its "text model" averages a
character embedding; its "vision model" maps the mean red, green and blue of
the picture to the same space, and the descriptions are shaped so that a red
picture matches what mentions fire, a green one nature, a blue one water or
sky. Regenerate with:  python make.py   (needs `pip install onnx numpy`).
"""
import json
import os

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

HERE = os.path.dirname(os.path.abspath(__file__))
D = 8
CHARS = "abcdefghijklmnopqrstuvwxyz0123456789 ,.'-&"
SPECIAL = ["<|startoftext|>", "<|endoftext|>", "<unk>"]
VOCAB = {t: i for i, t in enumerate(SPECIAL)}
for c in CHARS:
    if c != " ":
        VOCAB[c] = len(VOCAB)

rng = np.random.default_rng(7)
E = rng.normal(0, 0.15, (len(VOCAB), D)).astype(np.float32)
E[: len(SPECIAL)] = 0
# Letters that lean a description towards a colour (dims 0, 1, 2 = red, green, blue).
for c, dim in [("r", 0), ("f", 0), ("w", 2), ("g", 1), ("n", 1), ("s", 2), ("k", 2)]:
    E[VOCAB[c], dim] += 1.0


def text_model():
    ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"])
    mask = helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "seq"])
    out = helper.make_tensor_value_info("text_embeds", TensorProto.FLOAT, ["batch", D])
    nodes = [
        helper.make_node("Gather", ["E", "input_ids"], ["emb"], axis=0),
        helper.make_node("Cast", ["attention_mask"], ["maskf"], to=TensorProto.FLOAT),
        helper.make_node("Unsqueeze", ["maskf", "axis2"], ["mask3"]),
        helper.make_node("Mul", ["emb", "mask3"], ["masked"]),
        helper.make_node("ReduceSum", ["masked", "axis1"], ["summed"], keepdims=0),
        helper.make_node("ReduceSum", ["mask3", "axis1"], ["count"], keepdims=0),
        helper.make_node("Div", ["summed", "count"], ["text_embeds"]),
    ]
    inits = [
        numpy_helper.from_array(E, "E"),
        numpy_helper.from_array(np.array([2], dtype=np.int64), "axis2"),
        numpy_helper.from_array(np.array([1], dtype=np.int64), "axis1"),
    ]
    g = helper.make_graph(nodes, "tiny_clip_text", [ids, mask], [out], inits)
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)


def vision_model():
    px = helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, ["batch", 3, 224, 224])
    out = helper.make_tensor_value_info("image_embeds", TensorProto.FLOAT, ["batch", D])
    W = np.zeros((3, D), dtype=np.float32)
    W[0, 0] = W[1, 1] = W[2, 2] = 1.0
    nodes = [
        helper.make_node("ReduceMean", ["pixel_values"], ["rgb"], axes=[2, 3], keepdims=0),
        helper.make_node("MatMul", ["rgb", "W"], ["image_embeds"]),
    ]
    g = helper.make_graph(nodes, "tiny_clip_vision", [px], [out], [numpy_helper.from_array(W, "W")])
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)


def special(token, i):
    return {"id": i, "content": token, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True}


tokenizer = {
    "version": "1.0",
    "truncation": None,
    "padding": None,
    "added_tokens": [special(t, i) for i, t in enumerate(SPECIAL)],
    "normalizer": {"type": "Lowercase"},
    "pre_tokenizer": {"type": "Whitespace"},
    "post_processor": {
        "type": "TemplateProcessing",
        "single": [
            {"SpecialToken": {"id": "<|startoftext|>", "type_id": 0}},
            {"Sequence": {"id": "A", "type_id": 0}},
            {"SpecialToken": {"id": "<|endoftext|>", "type_id": 0}},
        ],
        "pair": [
            {"SpecialToken": {"id": "<|startoftext|>", "type_id": 0}},
            {"Sequence": {"id": "A", "type_id": 0}},
            {"SpecialToken": {"id": "<|endoftext|>", "type_id": 0}},
            {"Sequence": {"id": "B", "type_id": 0}},
            {"SpecialToken": {"id": "<|endoftext|>", "type_id": 0}},
        ],
        "special_tokens": {
            "<|startoftext|>": {"id": "<|startoftext|>", "ids": [0], "tokens": ["<|startoftext|>"]},
            "<|endoftext|>": {"id": "<|endoftext|>", "ids": [1], "tokens": ["<|endoftext|>"]},
        },
    },
    "decoder": None,
    "model": {
        "type": "BPE",
        "dropout": None,
        "unk_token": "<unk>",
        "continuing_subword_prefix": None,
        "end_of_word_suffix": None,
        "fuse_unk": False,
        "byte_fallback": False,
        "vocab": VOCAB,
        "merges": [],
    },
}

tokenizer_config = {
    "tokenizer_class": "CLIPTokenizer",
    "model_max_length": 77,
    "bos_token": "<|startoftext|>",
    "eos_token": "<|endoftext|>",
    "pad_token": "<|endoftext|>",
    "unk_token": "<unk>",
    "do_lower_case": True,
}

config = {
    "model_type": "clip",
    "architectures": ["CLIPModel"],
    "projection_dim": D,
    "logit_scale_init_value": 4.6052,
    "text_config": {"model_type": "clip_text_model", "hidden_size": D, "vocab_size": len(VOCAB), "max_position_embeddings": 77},
    "vision_config": {"model_type": "clip_vision_model", "hidden_size": D, "image_size": 224, "patch_size": 32},
}

os.makedirs(os.path.join(HERE, "onnx"), exist_ok=True)
onnx.save(text_model(), os.path.join(HERE, "onnx", "text_model_quantized.onnx"))
onnx.save(vision_model(), os.path.join(HERE, "onnx", "vision_model_quantized.onnx"))
for name, data in [("tokenizer.json", tokenizer), ("tokenizer_config.json", tokenizer_config), ("config.json", config)]:
    with open(os.path.join(HERE, name), "w") as f:
        json.dump(data, f, indent=1)
        f.write("\n")
print("ok", len(VOCAB), "tokens")
