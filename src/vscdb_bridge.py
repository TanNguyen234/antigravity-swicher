import sqlite3
import os
import json
import sys
import platform

def get_db_path():
    system = platform.system()
    if system == 'Windows':
        appdata = os.environ.get('APPDATA') or os.path.expanduser('~\\AppData\\Roaming')
        return os.path.join(appdata, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
    elif system == 'Darwin':
        return os.path.expanduser('~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb')
    else:
        # Linux / Unix
        config_dir = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
        return os.path.join(config_dir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')


def export_auth():
    db_path = get_db_path()
    if not os.path.exists(db_path):
        return {}
    try:
        con = sqlite3.connect(db_path, timeout=5.0)
        con.execute("PRAGMA busy_timeout = 5000;")
        cur = con.cursor()
        keys = [
            'antigravityUnifiedStateSync.oauthToken',
            'antigravityUnifiedStateSync.userStatus',
            'antigravity.profileUrl',
            'antigravityUnifiedStateSync.modelCredits'
        ]
        data = {}
        for k in keys:
            cur.execute('SELECT value FROM ItemTable WHERE key=?', (k,))
            row = cur.fetchone()
            if row and row[0] is not None:
                data[k] = row[0]
        con.close()
        return data
    except Exception as e:
        sys.stderr.write(f"[vscdb_bridge] Lỗi export: {str(e)}\n")
        return {}

def import_auth(json_file_path):
    db_path = get_db_path()
    if not os.path.exists(db_path) or not os.path.exists(json_file_path):
        return False
    try:
        with open(json_file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict) or not data:
            return False

        con = sqlite3.connect(db_path, timeout=5.0)
        con.execute("PRAGMA busy_timeout = 5000;")
        cur = con.cursor()
        for k, v in data.items():
            if v is not None:
                cur.execute('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', (k, v))
        con.commit()
        con.close()
        return True
    except Exception as e:
        sys.stderr.write(f"[vscdb_bridge] Lỗi import: {str(e)}\n")
        return False

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(1)
    
    cmd = sys.argv[1]
    if cmd == 'export':
        data = export_auth()
        json_bytes = json.dumps(data).encode('utf-8')
        sys.stdout.buffer.write(json_bytes)
    elif cmd == 'import' and len(sys.argv) >= 3:
        success = import_auth(sys.argv[2])
        sys.stdout.write('OK' if success else 'FAIL')
    else:
        sys.exit(1)
