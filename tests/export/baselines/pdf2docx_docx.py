#!/usr/bin/env python3
"""Baseline PDF -> DOCX converter: pdf2docx (PyMuPDF based).  Usage: pdf2docx_docx.py in.pdf out.docx"""
import logging
import sys
import warnings

warnings.filterwarnings("ignore")
logging.disable(logging.WARNING)

from pdf2docx import Converter  # noqa: E402


def main():
    src, dst = sys.argv[1], sys.argv[2]
    cv = Converter(src)
    try:
        cv.convert(dst)
    finally:
        cv.close()


if __name__ == "__main__":
    main()
