import sys
import json
import requests
import datetime
import socket
import logging
import subprocess
import time
import queue
import shutil
from pathlib import Path
from PyQt5 import uic
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QTableWidget, QTableWidgetItem,
    QVBoxLayout, QHeaderView, QMessageBox
)
from PyQt5.QtCore import (
    QThread, QMutex, QMutexLocker, QWaitCondition, pyqtSignal,
    QTimer, pyqtSlot, QDateTime
)
from PyQt5.QtNetwork import QHostAddress
from PyQt5.QtWebSockets import QWebSocketServer

import os

def _load_service_token():
    token = os.getenv("TASKQUE_SERVICE_TOKEN")
    if token:
        return token.strip()
    try:
        env_path = Path(__file__).resolve().parents[1] / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                if key.strip() == "TASKQUE_SERVICE_TOKEN":
                    return val.strip().strip("'\"")
    except Exception:
        pass
    return "change-me-in-production"

SERVICE_TOKEN = _load_service_token()

# ---------------------------------------------------------
# 0. LOGGING SETUP
# ---------------------------------------------------------
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

def setup_logging():
    """Setup logging to file with rotation (keep last 3 days)"""
    log_file = LOG_DIR / f"playout_engine_{datetime.datetime.now().strftime('%Y%m%d')}.log"

    for old_log in LOG_DIR.glob("playout_engine_*.log"):
        try:
            date_str = old_log.stem.replace("playout_engine_", "")
            log_date = datetime.datetime.strptime(date_str, "%Y%m%d")
            if (datetime.datetime.now() - log_date).days > 3:
                old_log.unlink()
        except:
            pass

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(threadName)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file, encoding='utf-8'),
            logging.StreamHandler()
        ]
    )
    return logging.getLogger(__name__)

logger = setup_logging()

# ---------------------------------------------------------
# 1. CASPARCG GATEWAY (Gatekeeper Thread 1)
# ---------------------------------------------------------
class CasparGatewayThread(QThread):
    """
    Holds a single persistent TCP socket to CasparCG.
    Consumes AMCP commands from a thread-safe queue sequentially.
    """
    result_ready = pyqtSignal(dict, str, str, str, bool)

    def __init__(self, host='127.0.0.1', port=5250):
        super().__init__()
        self.host = host
        self.port = port
        self.cmd_queue = queue.Queue()
        self.running = True
        self.sock = None

    def connect_socket(self):
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(5.0)
            self.sock.connect((self.host, self.port))
            logger.info(f"Gateway connected to CasparCG at {self.host}:{self.port}")
            return True
        except Exception as e:
            logger.error(f"Gateway failed to connect: {e}")
            self.sock = None
            return False

    def run(self):
        self.connect_socket()

        while self.running:
            try:
                job = self.cmd_queue.get(timeout=1.0)
            except queue.Empty:
                continue

            task = job['task']
            action = job['action']
            cmd_str = job['cmd'] + '\r\n'
            is_manual = job.get('is_manual', False)

            response_text = ""
            status = "Failed"

            if not self.sock:
                self.connect_socket()

            if self.sock:
                try:
                    self.sock.send(cmd_str.encode('utf-8'))
                    response = self.sock.recv(4096).decode('utf-8')
                    response_text = response.strip()
                    if "RESULT" in response_text or "202" in response_text or "201" in response_text:
                        status = "Completed"
                except Exception as e:
                    response_text = f"Socket Error: {e}"
                    self.sock.close()
                    self.sock = None
            else:
                response_text = "No connection to CasparCG server"

            self.result_ready.emit(task, action, status, response_text, is_manual)
            self.cmd_queue.task_done()

    def stop(self):
        self.running = False
        if self.sock:
            self.sock.close()
        self.wait()

# ---------------------------------------------------------
# 2. DISK I/O COORDINATOR (Gatekeeper Thread 2)
# ---------------------------------------------------------
class DiskCoordinatorThread(QThread):
    """Handles cross-volume moving and renaming of files from local to FTP Z: drive."""
    result_ready = pyqtSignal(dict, str, str, str)

    # Path to your reference file and untrunc.exe
    UNTRUNC_EXE = Path(r"D:\untrunc\untrunc.exe")
    REFERENCE_FILE = Path(r"D:\untrunc\reference.mp4")

    def __init__(self):
        super().__init__()
        self.job_queue = queue.Queue()
        self.running = True

    def run(self):
        while self.running:
            try:
                job = self.job_queue.get(timeout=1.0)
            except queue.Empty:
                continue

            task = job['task']
            old_path = job['old_path']
            new_path = job['new_path']

            # Step 1: Check file integrity with ffmpeg
            is_corrupt, ffmpeg_output = self.check_with_ffmpeg(old_path)

            if is_corrupt:
                logger.warning(f"[DiskCoordinator] ffmpeg detected issue in {old_path.name}: {ffmpeg_output}")
                self.result_ready.emit(task, "FFmpeg Check", "Warning", f"Corrupt — attempting untrunc: {ffmpeg_output}")

                # Step 2: Attempt untrunc repair in-place
                repaired = self.run_untrunc(old_path)

                if repaired:
                    logger.info(f"[DiskCoordinator] untrunc repaired {old_path.name} successfully.")
                    self.result_ready.emit(task, "Untrunc Repair", "Completed", f"Repaired: {old_path.name}")
                else:
                    logger.error(f"[DiskCoordinator] untrunc failed on {old_path.name}. Moving as-is.")
                    self.result_ready.emit(task, "Untrunc Repair", "Failed", f"Could not repair: {old_path.name} — moving anyway.")
            else:
                logger.info(f"[DiskCoordinator] ffmpeg check passed for {old_path.name}.")
                self.result_ready.emit(task, "FFmpeg Check", "Completed", f"No issues found in {old_path.name}")

            # Step 3: Move and rename regardless (repaired or not)
            success = self.safe_rename_and_move(old_path, new_path)

            status = "Completed" if success else "Failed"
            details = f"Moved & Renamed to {new_path}" if success else f"File lock or missing: {old_path.name}"
            self.result_ready.emit(task, "Rename & Move File", status, details)

            self.job_queue.task_done()

    def check_with_ffmpeg(self, file_path: Path, max_wait=30, interval=2) -> tuple[bool, str]:
        """
        Runs ffmpeg -v error -i <file> -f null - and checks stderr for errors.
        Waits up to max_wait seconds for the file to appear before giving up.
        Returns (is_corrupt: bool, error_output: str).
        """
        # Wait for file to exist and be non-zero before probing
        waited = 0
        while waited < max_wait:
            if file_path.exists() and file_path.stat().st_size > 0:
                break
            logger.info(f"[FFmpeg Check] Waiting for {file_path.name} to be ready... ({waited}s)")
            time.sleep(interval)
            waited += interval
        else:
            return True, f"File not found or empty after {max_wait}s wait."

        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v", "error",
                    "-show_entries", "stream=codec_type,duration",
                    "-of", "default=noprint_wrappers=1",
                    str(file_path)
                ],
                capture_output=True,
                text=True,
                timeout=30  # ffprobe should never need more than this
            )

            stderr = result.stderr.strip()

            # ffmpeg writes errors/warnings to stderr even on exit code 0
            # Flag as corrupt only on real error lines, not harmless warnings
            error_lines = [
                line for line in stderr.splitlines()
                if any(kw in line.lower() for kw in [
                    "error", "invalid", "corrupt", "truncat",
                    "missing", "moov atom not found"
                ])
            ]

            if error_lines:
                return True, " | ".join(error_lines[:5])  # Cap to first 5 lines
            return False, ""

        except subprocess.TimeoutExpired:
            return True, "ffmpeg probe timed out — treating as corrupt."
        except FileNotFoundError:
            logger.error("[FFmpeg Check] ffmpeg not found in PATH.")
            return False, ""  # Don't block the move if ffmpeg is missing
        except Exception as e:
            logger.error(f"[FFmpeg Check] Unexpected error: {e}")
            return False, str(e)

    def run_untrunc(self, corrupt_file: Path) -> bool:
        if not self.UNTRUNC_EXE.exists():
            logger.error(f"[Untrunc] untrunc.exe not found at {self.UNTRUNC_EXE}")
            return False

        if not self.REFERENCE_FILE.exists():
            logger.error(f"[Untrunc] Reference file not found at {self.REFERENCE_FILE}")
            return False

        fixed_candidates = [
            corrupt_file.with_name(corrupt_file.name + "_fixed.mp4"),  # recording.mp4_fixed.mp4
            corrupt_file.with_name(corrupt_file.stem + "_fixed.mp4"),
        ]

        try:
            logger.info(f"[Untrunc] Starting repair on {corrupt_file.name} — this may take a while...")
            result = subprocess.run(
                [str(self.UNTRUNC_EXE), str(self.REFERENCE_FILE), str(corrupt_file)],
                capture_output=True,
                text=True,
                timeout=1800  # Raise to 30 minutes — large files need it
            )

            logger.info(f"[Untrunc] stdout: {result.stdout.strip()[:500]}")
            if result.stderr:
                logger.warning(f"[Untrunc] stderr: {result.stderr.strip()[:500]}")

            # Check for separately written fixed file FIRST
            # (untrunc commonly writes _fixed.mp4 rather than overwriting)
            for candidate in fixed_candidates:
                if candidate.exists() and candidate.stat().st_size > 0:
                    logger.info(f"[Untrunc] Found repaired file: {candidate.name} — replacing original.")
                    candidate.replace(corrupt_file)
                    return True

            # If no _fixed file found, check if original was repaired in-place
            if corrupt_file.exists() and corrupt_file.stat().st_size > 0:
                still_corrupt, reason = self.check_with_ffmpeg(corrupt_file)
                if not still_corrupt:
                    logger.info(f"[Untrunc] In-place repair verified clean for {corrupt_file.name}")
                    return True
                else:
                    logger.warning(f"[Untrunc] Re-verification still shows issues: {reason}")
                    return False

            return False

        except subprocess.TimeoutExpired:
            logger.error(f"[Untrunc] Timed out repairing {corrupt_file.name}")
            return False
        except Exception as e:
            logger.error(f"[Untrunc] Unexpected error: {e}")
            return False

    def safe_rename_and_move(self, old_path: Path, new_path: Path, max_retries=10, delay=5):
        time.sleep(delay)
        for attempt in range(max_retries):
            if not old_path.exists():
                time.sleep(delay)
                continue

            try:
                new_path.parent.mkdir(parents=True, exist_ok=True)

                if new_path.exists():
                    new_path.unlink()

                shutil.move(str(old_path), str(new_path))
                logger.info(f"Successfully moved and renamed {old_path.name} -> {new_path}")
                return True
            except PermissionError:
                logger.warning(f"File {old_path.name} locked by server process. Retrying {attempt+1}/{max_retries}...")
                time.sleep(delay)
            except Exception as e:
                logger.error(f"Unexpected file system transfer error on {old_path.name}: {e}")
                return False

        return False

    def stop(self):
        self.running = False
        self.wait()


# ---------------------------------------------------------
# 3. DJANGO API UPDATER (Gatekeeper Thread 3)
# ---------------------------------------------------------
class DjangoApiUpdaterThread(QThread):
    def __init__(self, base_url="http://127.0.0.1:8000/api/record_cron/"):
        super().__init__()
        self.job_queue = queue.Queue()
        self.running = True
        self.base_url = base_url

    def run(self):
        while self.running:
            try:
                job = self.job_queue.get(timeout=1.0)
            except queue.Empty:
                continue

            rec_id = job['rec_id']
            payload = job['payload']

            try:
                response = requests.patch(
                    f"{self.base_url}{rec_id}/",
                    json=payload,
                    timeout=5.0,
                    headers={"X-Service-Token": SERVICE_TOKEN}
                )
                if response.status_code in [200, 204]:
                    logger.info(f"Django updated successfully for Rec ID {rec_id} -> {payload}")
                else:
                    logger.error(f"Django update failed for Rec ID {rec_id} (Code {response.status_code}): {response.text}")
            except Exception as e:
                logger.error(f"Network error updating Django API for Rec ID {rec_id}: {e}")

            self.job_queue.task_done()

    def stop(self):
        self.running = False
        self.wait()

# ---------------------------------------------------------
# 4. CORE SCHEDULER DAEMON
# ---------------------------------------------------------
class SchedulerThread(QThread):
    event_triggered = pyqtSignal(str, dict, bool)

    def __init__(self):
        super().__init__()
        self.events = []
        self.mutex = QMutex()
        self.cond = QWaitCondition()
        self.running = True

    def update_tasks(self, tasks):
        with QMutexLocker(self.mutex):
            self.events.clear()
            tz = datetime.timezone(datetime.timedelta(hours=6))
            now = datetime.datetime.now(tz)

            for t in tasks:
                try:
                    start_dt = datetime.datetime.fromisoformat(t['start_time'].replace('Z', '+00:00'))
                    if start_dt > now:
                        self.events.append((start_dt, 'START_REC', t))
                except (KeyError, ValueError):
                    pass

                try:
                    end_dt = datetime.datetime.fromisoformat(t['end_time'].replace('Z', '+00:00'))
                    if end_dt > now:
                        self.events.append((end_dt, 'STOP_REC', t))
                except (KeyError, ValueError):
                    pass

            self.events.sort(key=lambda x: x[0])
            self.cond.wakeAll()

    def run(self):
        while self.running:
            self.mutex.lock()
            if not self.events:
                self.cond.wait(self.mutex)
                self.mutex.unlock()
                continue

            next_time, action, task = self.events[0]
            tz = datetime.timezone(datetime.timedelta(hours=6))
            now = datetime.datetime.now(tz)
            delta_ms = int((next_time - now).total_seconds() * 1000)

            if delta_ms <= 0:
                self.events.pop(0)
                self.mutex.unlock()
                self.event_triggered.emit(action, task, False)
            else:
                self.cond.wait(self.mutex, delta_ms)
                self.mutex.unlock()

    def stop(self):
        self.running = False
        self.cond.wakeAll()
        self.wait()

# ---------------------------------------------------------
# 5. HISTORY LOG MANAGER
# ---------------------------------------------------------
class HistoryLogManager:
    def __init__(self):
        self.history_file = LOG_DIR / "history_log.json"
        self.ensure_log_file()

    def ensure_log_file(self):
        if not self.history_file.exists():
            with open(self.history_file, 'w', encoding='utf-8') as f:
                json.dump([], f)

    def load_history(self):
        try:
            with open(self.history_file, 'r', encoding='utf-8') as f:
                all_history = json.load(f)

            tz = datetime.timezone(datetime.timedelta(hours=6))
            three_days_ago = datetime.datetime.now(tz) - datetime.timedelta(days=3)

            filtered_history = [e for e in all_history if datetime.datetime.fromisoformat(e['executed_at']) > three_days_ago]

            with open(self.history_file, 'w', encoding='utf-8') as f:
                json.dump(filtered_history, f, indent=2)
            return filtered_history
        except Exception as e:
            logger.error(f"Error loading history: {e}")
            return []

    def add_history_entry(self, rec_id, filename, task_type, status, details=""):
        try:
            with open(self.history_file, 'r', encoding='utf-8') as f:
                history = json.load(f)

            tz = datetime.timezone(datetime.timedelta(hours=6))
            entry = {
                'rec_id': rec_id,
                'filename': filename,
                'task_type': task_type,
                'status': status,
                'executed_at': datetime.datetime.now(tz).isoformat(),
                'details': details
            }
            history.append(entry)

            three_days_ago = datetime.datetime.now(tz) - datetime.timedelta(days=3)
            history = [h for h in history if datetime.datetime.fromisoformat(h['executed_at']) > three_days_ago]

            with open(self.history_file, 'w', encoding='utf-8') as f:
                json.dump(history, f, indent=2)
        except Exception as e:
            logger.error(f"Error adding history entry: {e}")

# ---------------------------------------------------------
# 6. MAIN WINDOW & APP CONTROLLER
# ---------------------------------------------------------
class PlayoutEngine(QMainWindow):
    def __init__(self):
        super().__init__()
        uic.loadUi('mainwindow.ui', self)

        self.tasks = []
        self.clients = []
        self.task_queue = []

        self._fired_actions: set[tuple] = set()  # (rec_id, action) pairs already sent
        self._fired_actions_lock = QMutex()

        # Drive Configuration Paths
        self.media_path = "D:\\Program\\casperCG\\media"
        self.destination_path = "Z:\\"  # Mounted FTP Target Directory Location

        self.history_manager = HistoryLogManager()
        self.setup_ui()

        # 1. Start CasparCG Gateway
        self.caspar_gateway = CasparGatewayThread(host='127.0.0.1', port=5250)
        self.caspar_gateway.result_ready.connect(self.on_caspar_result)
        self.caspar_gateway.start()

        # 2. Start Disk Coordinator
        self.disk_coordinator = DiskCoordinatorThread()
        self.disk_coordinator.result_ready.connect(self.on_disk_result)
        self.disk_coordinator.start()

        # 3. Start Django API Updater
        self.api_updater = DjangoApiUpdaterThread(base_url="http://127.0.0.1:8000/api/record_cron/")
        self.api_updater.start()

        # 4. Start Scheduler
        self.scheduler = SchedulerThread()
        self.scheduler.event_triggered.connect(self.dispatch_task)
        self.scheduler.start()

        # WebSockets
        self.ws_server = QWebSocketServer("IngestX_WS", QWebSocketServer.NonSecureMode)
        if self.ws_server.listen(QHostAddress.LocalHost, 8765):
            logger.info("WebSocket Server listening on ws://0.0.0.0:8765")
        self.ws_server.newConnection.connect(self.on_new_ws_connection)

        self.refresh_tasks()
        self.setup_midnight_refresh()

        self.broadcast_timer = QTimer(self)
        self.broadcast_timer.timeout.connect(self.broadcast_state)
        self.broadcast_timer.start(1000)

        self.load_history_from_log()

    def setup_ui(self):
        self.table_que.setColumnCount(5)
        self.table_que.setHorizontalHeaderLabels(["Timestamp", "Task Type", "Rec ID", "File Name", "Status"])
        header = self.table_que.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.Stretch)
        header.setSectionResizeMode(4, QHeaderView.ResizeToContents)

        self.table_hist.setColumnCount(5)
        self.table_hist.setHorizontalHeaderLabels(["Rec ID", "File Name", "Task Type", "Status", "Executed At"])

        # Set column resize modes similar to que_tab
        hist_header = self.table_hist.horizontalHeader()
        hist_header.setSectionResizeMode(0, QHeaderView.ResizeToContents)  # Rec ID
        hist_header.setSectionResizeMode(1, QHeaderView.Stretch)          # File Name
        hist_header.setSectionResizeMode(2, QHeaderView.ResizeToContents) # Task Type
        hist_header.setSectionResizeMode(3, QHeaderView.ResizeToContents) # Status
        hist_header.setSectionResizeMode(4, QHeaderView.ResizeToContents) # Executed At


        # When adding data to history table, insert at the top instead of bottom
        # Instead of using: row = self.table_hist.rowCount()
        # Use: self.table_hist.insertRow(0)
        # Example:
        # row = 0
        # self.table_hist.insertRow(row)
        # self.table_hist.setItem(row, 0, QTableWidgetItem(rec_id))
        # self.table_hist.setItem(row, 1, QTableWidgetItem(file_name))
        # etc...

    def setup_midnight_refresh(self):
        now = QDateTime.currentDateTime()
        midnight = QDateTime.currentDateTime()
        midnight.setTime(QDateTime.fromString("00:00:00", "HH:mm:ss").time())
        if now > midnight:
            midnight = midnight.addDays(1)
        self.midnight_timer = QTimer(self)
        self.midnight_timer.setSingleShot(True)
        self.midnight_timer.timeout.connect(self.midnight_refresh)
        self.midnight_timer.start(now.msecsTo(midnight))

    def midnight_refresh(self):
        self.refresh_tasks()
        self.setup_midnight_refresh()

    def refresh_tasks(self):
        self.fetch_django_recordings()
        self.build_task_queue()
        self.populate_que_table()
        self.scheduler.update_tasks(self.tasks)

        tz = datetime.timezone(datetime.timedelta(hours=6))
        now = datetime.datetime.now(tz)

        for task in self.tasks:
            try:
                end_dt = datetime.datetime.fromisoformat(task['end_time'].replace('Z', '+00:00'))
            except (KeyError, ValueError):
                continue

            # Only attempt move if the recording should already be finished
            if end_dt > now:
                continue

            file_path = Path(f"{self.media_path}\\{task['id']}.mp4")
            target_path = Path(f"{self.destination_path}\\{task['filename']}.mp4")
            if file_path.exists() and not target_path.exists():
                self.disk_coordinator.job_queue.put({
                    'task': task,
                    'old_path': file_path,
                    'new_path': target_path
                })

    def fetch_django_recordings(self):
        try:
            tz = datetime.timezone(datetime.timedelta(hours=6))
            now = datetime.datetime.now(tz)
            response = requests.get(
                "http://127.0.0.1:8000/api/recordings/",
                timeout=5,
                headers={"X-Service-Token": SERVICE_TOKEN}
            )
            if response.status_code == 200:
                all_tasks = response.json()
                self.tasks = [t for t in all_tasks if datetime.datetime.fromisoformat(t['end_time'].replace('Z', '+00:00')) > now]
        except requests.exceptions.RequestException as e:
            logger.error(f"API Error: {e}")

    def build_task_queue(self):
        self.task_queue = []
        tz = datetime.timezone(datetime.timedelta(hours=6))
        now = datetime.datetime.now(tz)
        for task in self.tasks:
            try:
                start_dt = datetime.datetime.fromisoformat(task['start_time'].replace('Z', '+00:00'))
                if start_dt > now:
                    self.task_queue.append({'timestamp': start_dt, 'task_type': 'Start Rec', 'rec_id': task['id'], 'filename': task['filename'], 'status': 'Pending', 'raw_task': task})
            except (KeyError, ValueError):
                pass

            try:
                end_dt = datetime.datetime.fromisoformat(task['end_time'].replace('Z', '+00:00'))
                if end_dt > now:
                    self.task_queue.append({'timestamp': end_dt, 'task_type': 'Stop Rec', 'rec_id': task['id'], 'filename': task['filename'], 'status': 'Pending', 'raw_task': task})
            except (KeyError, ValueError):
                pass

        self.task_queue.sort(key=lambda x: x['timestamp'])

    def populate_que_table(self):
        self.table_que.setRowCount(0)
        for item in self.task_queue:
            row = self.table_que.rowCount()
            self.table_que.insertRow(row)
            self.table_que.setItem(row, 0, QTableWidgetItem(item['timestamp'].strftime("%Y-%m-%d %H:%M:%S")))
            self.table_que.setItem(row, 1, QTableWidgetItem(item['task_type']))
            self.table_que.setItem(row, 2, QTableWidgetItem(str(item['rec_id'])))
            self.table_que.setItem(row, 3, QTableWidgetItem(item['filename']))
            self.table_que.setItem(row, 4, QTableWidgetItem(item['status']))

    def load_history_from_log(self):
        entries = self.history_manager.load_history()
        self.table_hist.setRowCount(0)
        for entry in reversed(entries):
            row = self.table_hist.rowCount()
            self.table_hist.insertRow(row)
            self.table_hist.setItem(row, 0, QTableWidgetItem(str(entry['rec_id'])))
            self.table_hist.setItem(row, 1, QTableWidgetItem(entry['filename']))
            self.table_hist.setItem(row, 2, QTableWidgetItem(entry['task_type']))
            self.table_hist.setItem(row, 3, QTableWidgetItem(entry['status']))
            exec_time = datetime.datetime.fromisoformat(entry['executed_at'])
            self.table_hist.setItem(row, 4, QTableWidgetItem(exec_time.strftime("%Y-%m-%d %H:%M:%S")))

    # ---------------------------------------------------------
    # SIGNAL HANDLERS
    # ---------------------------------------------------------
    @pyqtSlot(str, dict, bool)
    def dispatch_task(self, action, task, is_manual=False):
        key = (task['id'], action)

        with QMutexLocker(self._fired_actions_lock):
            if key in self._fired_actions:
                logger.warning(
                    f"DUPLICATE SUPPRESSED: action={action} rec_id={task['id']} "
                    f"({'manual' if is_manual else 'scheduled'}) — already fired, ignoring."
                )
                return
            self._fired_actions.add(key)

        channel = task.get('port', 1)
        filename = f"{task['id']}.mp4"

        if action == 'START_REC':
            cmd = (
                f'ADD {channel} FILE {filename} {self.media_path} '
                f'-filter:a "pan=stereo|c0=c0|c1=c1" '
                f'-filter:v "setdar=4/3" '
                f'-movflags +frag_keyframe+empty_moov+faststart'
            )
        elif action == 'STOP_REC':
            cmd = f"REMOVE {channel} FILE {filename}"
        else:
            return

        self.caspar_gateway.cmd_queue.put({
            'action': action,
            'task': task,
            'cmd': cmd,
            'is_manual': is_manual
        })

    @pyqtSlot(dict, str, str, str, bool)
    def on_caspar_result(self, task, action, status, response, is_manual):
        ui_action = "Start Recording" if action == 'START_REC' else "Stop Recording"

        self.history_manager.add_history_entry(task['id'], task['filename'], ui_action, status, response)
        self.load_history_from_log()

        q_type = 'Start Rec' if action == 'START_REC' else 'Stop Rec'
        for item in self.task_queue:
            if item['rec_id'] == task['id'] and item['task_type'] == q_type:
                item['status'] = status
        self.populate_que_table()

        if not is_manual:
            api_status = None
            if action == 'START_REC':
                api_status = "RECORDING" if status == 'Completed' else "FAILED"
            elif action == 'STOP_REC':
                api_status = "COMPLETED" if status == 'Completed' else "FAILED"

            if api_status:
                self.api_updater.job_queue.put({
                    'rec_id': task['id'],
                    'payload': {'status': api_status}
                })

        if action == 'STOP_REC' and status == 'Completed':
            old_path = Path(f"{self.media_path}\\{task['id']}.mp4")
            new_path = Path(f"{self.destination_path}\\{task['filename']}.mp4")
            self.disk_coordinator.job_queue.put({
                'task': task,
                'old_path': old_path,
                'new_path': new_path
            })

            # Release idempotency keys so the rec_id slot can be reused if rescheduled
            with QMutexLocker(self._fired_actions_lock):
                self._fired_actions.discard((task['id'], 'START_REC'))
                self._fired_actions.discard((task['id'], 'STOP_REC'))

            if is_manual:
                self.tasks = [t for t in self.tasks if t['id'] != task['id']]
                self.task_queue = [item for item in self.task_queue if item['rec_id'] != task['id']]
                self.populate_que_table()
                self.scheduler.update_tasks(self.tasks)
                logger.info(f"Task ID {task['id']} cleaned up from memory after confirmed manual force stop.")

    @pyqtSlot(dict, str, str, str)
    def on_disk_result(self, task, task_type, status, details):
        self.history_manager.add_history_entry(task['id'], task['filename'], task_type, status, details)
        self.load_history_from_log()
        self.refresh_tasks()

    # ---------------------------------------------------------
    # WEBSOCKET FOR REAL-TIME DJANGO COMMUNICATION
    # ---------------------------------------------------------
    def on_new_ws_connection(self):
        client = self.ws_server.nextPendingConnection()
        client.textMessageReceived.connect(self.process_ws_message)
        client.disconnected.connect(lambda: self.clients.remove(client) if client in self.clients else None)
        self.clients.append(client)

    def process_ws_message(self, message):
        try:
            data = json.loads(message)
            command = data.get("command")
            task_details = data.get("task_data", data.get("task"))

            if data.get("token") != SERVICE_TOKEN:
                logger.warning("Rejected unauthorized WebSocket command (bad/missing token).")
                try:
                    self.sender().close()
                except Exception:
                    pass
                return

            if not command:
                return

            logger.info(f"WebSocket command received: {command}")

            if command == "CREATE" and task_details:
                self.tasks = [t for t in self.tasks if t['id'] != task_details['id']]
                self.tasks.append(task_details)

                self.build_task_queue()
                self.populate_que_table()
                self.scheduler.update_tasks(self.tasks)
                logger.info(f"Task ID {task_details['id']} dynamically added from web dashboard.")

            elif command == "UPDATE" and task_details:
                self.tasks = [t for t in self.tasks if t['id'] != task_details['id']]
                self.tasks.append(task_details)

                self.build_task_queue()
                self.populate_que_table()
                self.scheduler.update_tasks(self.tasks)
                logger.info(f"Task ID {task_details['id']} dynamically modified via Django Admin/REST.")

            elif command == "DELETE" and task_details:
                task_id = task_details.get("id")

                self.tasks = [t for t in self.tasks if t['id'] != task_id]
                self.task_queue = [item for item in self.task_queue if item['rec_id'] != task_id]

                self.populate_que_table()
                self.scheduler.update_tasks(self.tasks)
                logger.info(f"Task ID {task_id} purged from engine memory because it was deleted via REST.")

            elif command == "start_now" and task_details:
                self.tasks = [t for t in self.tasks if t['id'] != task_details['id']]
                self.tasks.append(task_details)

                tz = datetime.timezone(datetime.timedelta(hours=6))
                now = datetime.datetime.now(tz)
                end_dt = datetime.datetime.fromisoformat(task_details['end_time'].replace('Z', '+00:00'))

                logger.info(f"Executing immediate record request for ID {task_details['id']} ({task_details['filename']})")

                self.history_manager.add_history_entry(
                    rec_id=task_details['id'],
                    filename=task_details['filename'],
                    task_type="Start Recording (Immediate)",
                    status="Sent",
                    details="Triggered instantly via WebSocket."
                )
                self.load_history_from_log()

                self.dispatch_task('START_REC', task_details, is_manual=True)

                if end_dt > now:
                    self.task_queue.append({
                        'timestamp': end_dt,
                        'task_type': 'Stop Rec',
                        'rec_id': task_details['id'],
                        'filename': task_details['filename'],
                        'status': 'Pending',
                        'raw_task': task_details
                    })
                    self.task_queue.sort(key=lambda x: x['timestamp'])
                    self.populate_que_table()

                # FIX: Pass a modified copy of the task to update_tasks with start_time
                # set to a past time so the scheduler only registers the STOP_REC event,
                # never a START_REC. Without this, if start_time is still in the future
                # by even a millisecond, the scheduler fires a second ADD command.
                past_task = {**task_details, 'start_time': now.isoformat()}
                self.tasks = [t if t['id'] != task_details['id'] else past_task for t in self.tasks]
                self.scheduler.update_tasks(self.tasks)

            elif command == "update_task" and task_details:
                self.tasks = [t for t in self.tasks if t['id'] != task_details['id']]
                self.tasks.append(task_details)

                self.build_task_queue()
                self.populate_que_table()
                self.scheduler.update_tasks(self.tasks)
                logger.info(f"Task ID {task_details['id']} has been dynamically updated via Django.")

            elif command == "stop_now" and task_details:
                # FIX: Do NOT remove the task from self.tasks or self.task_queue here,
                # and do NOT queue a disk move job here. The task must stay alive in
                # memory so that on_caspar_result can find it when the AMCP confirmation
                # comes back. Only after that confirmation does the disk move trigger and
                # the task get cleaned up. Removing the task prematurely was causing both
                # the file truncation (race against CasparCG write) and the missing file
                # move (task gone from memory before on_caspar_result fired).
                logger.info(f"Force stop received for Task ID {task_details['id']} ({task_details['filename']}). "
                             f"Dispatching REMOVE command — disk move and cleanup will follow on CasparCG confirmation.")

                self.history_manager.add_history_entry(
                    rec_id=task_details['id'],
                    filename=task_details['filename'],
                    task_type="Stop Recording (Force)",
                    status="Sent",
                    details="Force stop command received live from Django WebSocket."
                )
                self.load_history_from_log()

                self.dispatch_task('STOP_REC', task_details, is_manual=True)

                # Update the queue row status to show "Stopping..." so the UI reflects
                # the in-flight state without fully removing the entry yet.
                for item in self.task_queue:
                    if item['rec_id'] == task_details['id'] and item['task_type'] == 'Stop Rec':
                        item['status'] = 'Stopping...'
                self.populate_que_table()

            elif command in ["update_schedule", "refresh_tasks"]:
                self.refresh_tasks()

            elif command == "rename_file":
                rec_id = data.get("rec_id")
                new_fn = data.get("new_filename")

                local_file = Path(f"{self.media_path}\\{rec_id}.mp4")
                old_path = local_file if local_file.exists() else Path(f"{self.destination_path}\\{rec_id}.mp4")

                self.disk_coordinator.job_queue.put({
                    'task': {'id': rec_id, 'filename': new_fn},
                    'old_path': old_path,
                    'new_path': Path(f"{self.destination_path}\\{new_fn}")
                })

            elif command == "get_status":
                status = {"pending": len([t for t in self.task_queue if t['status'] == 'Pending'])}
                self.sender().sendTextMessage(json.dumps({"type": "status", "data": status}))

        except Exception as e:
            logger.exception(f"Error processing websocket message: {e}")

    def broadcast_state(self):
        if not self.clients: return
        payload = json.dumps({
            "type": "live_update",
            "pending": len([t for t in self.task_queue if t['status'] == 'Pending']),
            "active": len(self.tasks)
        })
        for client in self.clients[:]:
            try:
                client.sendTextMessage(payload)
            except:
                pass

    def closeEvent(self, event):
        logger.info("Shutting down Playout Engine... Terminating Gatekeepers.")
        self.scheduler.stop()
        self.caspar_gateway.stop()
        self.disk_coordinator.stop()
        self.api_updater.stop()
        self.ws_server.close()
        super().closeEvent(event)

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = PlayoutEngine()
    window.show()
    sys.exit(app.exec_())