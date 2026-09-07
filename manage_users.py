"""
Manage accounts for the app's username+password sign-in.

There is deliberately no sign-up flow in the app itself — accounts are
added here, out of band, by whoever runs the server. Run this on the same
machine (and with the same working directory) as app.py, since it writes
directly to runs/users.json — the file app.py's /api/auth/login route
reads on every login attempt (see load_users() in app.py). You can run
this while the server is running; a newly-added account works immediately,
no restart needed.

Usage:
    python manage_users.py add <username> <first_name> <last_name>
        Prompts for a password (twice, to catch typos) rather than taking
        it as an argument, so it never ends up in shell history.
    python manage_users.py list
    python manage_users.py remove <username>
"""

import getpass
import json
import sys
from pathlib import Path

from werkzeug.security import generate_password_hash

USERS_FILE = Path(__file__).parent / "runs" / "users.json"


def load():
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text())
    return {}


def save(users):
    USERS_FILE.parent.mkdir(exist_ok=True)
    USERS_FILE.write_text(json.dumps(users, indent=2))


def cmd_add(args):
    if len(args) != 3:
        print("Usage: python manage_users.py add <username> <first_name> <last_name>")
        sys.exit(1)
    username, first_name, last_name = args
    username = username.strip().lower()

    password = getpass.getpass("Password: ")
    if not password:
        print("Password can't be empty.")
        sys.exit(1)
    if getpass.getpass("Confirm password: ") != password:
        print("Passwords didn't match.")
        sys.exit(1)

    users = load()
    is_update = username in users
    users[username] = {
        "password_hash": generate_password_hash(password),
        "first_name": first_name,
        "last_name": last_name,
    }
    save(users)
    verb = "Updated" if is_update else "Added"
    print(f"{verb} user '{username}' ({first_name} {last_name}).")


def cmd_list(_args):
    users = load()
    if not users:
        print("No users yet.")
        return
    for username, u in sorted(users.items()):
        print(f"{username}: {u['first_name']} {u['last_name']}")


def cmd_remove(args):
    if len(args) != 1:
        print("Usage: python manage_users.py remove <username>")
        sys.exit(1)
    username = args[0].strip().lower()
    users = load()
    if username not in users:
        print(f"No such user: {username}")
        sys.exit(1)
    del users[username]
    save(users)
    print(f"Removed user '{username}'.")


COMMANDS = {"add": cmd_add, "list": cmd_list, "remove": cmd_remove}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])
