"""python -m tapedeck [--port 8765] [--mock] [--mock-tape 6] [--no-browser]"""
import argparse
import threading
import webbrowser

import uvicorn

from .server import create_app


def main():
    ap = argparse.ArgumentParser(prog="tapedeck", description="TapeDeck label studio for the Brother PT-P700")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--mock", action="store_true", help="simulate a printer; labels are saved to out/")
    ap.add_argument("--mock-tape", type=int, default=6, help="tape width the mock printer reports")
    ap.add_argument("--fast-mock", action="store_true", help="mock prints instantly instead of real-time")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    app = create_app(mock=args.mock, mock_tape=args.mock_tape, realtime=not args.fast_mock)
    url = f"http://{args.host}:{args.port}/"
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print(f"TapeDeck running at {url}  (mock={'on' if args.mock else 'off'})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
