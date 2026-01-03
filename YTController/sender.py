import sys
import os
import threading
import keyboard

from flask import Flask, jsonify, request
from flask_socketio import SocketIO, emit

# --- CONFIGURATION PARAMETERS ---
SERVER_HOST = '127.0.0.1'
SERVER_PORT = 8000
FLASK_SECRET_KEY = os.environ.get('FLASK_SECRET_KEY', 'KEY') # IMPORTANT: Change in production or use env var

# Define hotkeys and their corresponding actions
# Format: { 'hotkey_string': {'log_message': '...', 'emit_action': '...'} }
HOTKEY_ACTIONS = {
    'pause break': {
        'log_message': "Pause/Break pressed: Toggling play/pause.",
        'emit_action': 'toggle_play_pause'
    },
    'f2': {
        'log_message': "F2 pressed: Skipping to next video.",
        'emit_action': 'next_video'
    },
    'f3': {
        'log_message': "F3 pressed: Adjusting volume up.",
        'emit_action': 'volume_up'
    },
    'f4': {
        'log_message': "F4 pressed: Adjusting volume down.",
        'emit_action': 'volume_down'
    },
    'escape': {
        'log_message': "F5 pressed: Rewinding video.",
        'emit_action': 'rewind'
    },
    'f6': {
        'log_message': "F6 pressed: Forwarding video.",
        'emit_action': 'forward'
    },
    # Add more hotkeys as needed
}

# --- Flask App and Socket.IO Setup ---
app = Flask(__name__)
app.config['SECRET_KEY'] = FLASK_SECRET_KEY
# Using 'gevent' or 'eventlet' is often preferred for async_mode with Flask-SocketIO for better performance,
# but 'threading' works fine for this use case and simplifies the hotkey listener thread management.
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# --- Flask Routes ---
@app.route('/')
def index():
    """Simple status check route."""
    return f"Desktop YouTube Controller Server running on {SERVER_HOST}:{SERVER_PORT}"

# # Optional: An HTTP endpoint to manually send commands (e.g., from another script)
# @app.route('/send_command', methods=['POST'])
# def send_command_http():
#     """HTTP endpoint to send commands to connected browser clients."""
#     data = request.json
#     command_action = data.get('action')
#     if command_action:
#         print(f"Received HTTP command: {command_action}")
#         # When emitting from a Flask route, we are already in a request context, so direct emit is fine.
#         socketio.emit('command_to_browser', {'action': command_action})
#         return jsonify({"status": "success", "message": f"Command '{command_action}' sent to browsers."})
#     return jsonify({"status": "error", "message": "No 'action' specified in request body."}), 400

# --- Socket.IO Event Handlers ---
@socketio.on('connect')
def handle_connect():
    """Handles new WebSocket client connections."""
    print(f'Browser client connected: {request.sid}')

@socketio.on('disconnect')
def handle_disconnect():
    """Handles WebSocket client disconnections."""
    print(f'Browser client disconnected: {request.sid}')

# --- Hotkey Listener ---
def _send_command_to_browsers(action_info: dict[str, str]):
    """Internal function to emit the Socket.IO message."""
    socketio.emit('command_to_browser', {'action': action_info['emit_action']})
    print(action_info['log_message'] + " (Command sent via WebSocket).")


def on_hotkey_press(hotkey_string: str):
    """Callback function for global hotkey presses."""
    action_info = HOTKEY_ACTIONS.get(hotkey_string)
    if action_info:
        # Schedule the emit call to be executed by Flask-SocketIO's event loop
        # This is the crucial change to avoid "Working outside of request context."
        socketio.start_background_task(_send_command_to_browsers, action_info)
    else:
        print(f"Unhandled hotkey pressed: {hotkey_string}")

def start_hotkey_listener():
    """Registers hotkeys and starts the listener in a non-blocking way."""
    for hotkey_string in HOTKEY_ACTIONS:
        # The lambda now just calls our on_hotkey_press with the hotkey_string
        keyboard.add_hotkey(hotkey_string, lambda hs=hotkey_string: on_hotkey_press(hs))
    print("Hotkey listener started. Press Ctrl+C to exit this console to stop the hotkeys.")
    # The Flask server will keep the main thread alive, and hotkey listener runs in its own thread.

def load_up_message():
    print(f"\n--- Desktop YouTube Controller Server ---")
    print(f"Server URL: http://{SERVER_HOST}:{SERVER_PORT}")
    print(f"WebSocket URL for UserScript: ws://{SERVER_HOST}:{SERVER_PORT}/socket.io/?EIO=4&transport=websocket")
    print("\nRegistered Hotkeys:")
    for hotkey, info in HOTKEY_ACTIONS.items():
        print(f"  - {hotkey.upper()}: {info['log_message']} (Emits: '{info['emit_action']}')")
    print("\nPress Ctrl+C to stop the server and hotkey listener.\n")

# --- Main Execution ---
if __name__ == '__main__':
    # Start the hotkey listener in a separate thread.
    # Flask-SocketIO's 'threading' async_mode ensures this works correctly.
    listener_thread = threading.Thread(target=start_hotkey_listener, daemon=True)
    listener_thread.start()

    load_up_message()

    # Run the Flask-SocketIO server
    try:
        # debug=False in production. allow_unsafe_werkzeug=True is for development.
        socketio.run(app, host=SERVER_HOST, port=SERVER_PORT, debug=False, allow_unsafe_werkzeug=True)
    except Exception as e:
        print(f"Error running server: {e}")
        print("Ensure the port is not already in use and that you have administrator privileges if required for hotkeys.")
    finally:
        keyboard.unhook_all() # Clean up keyboard hooks on exit
        print("Server and hotkey listener stopped.")