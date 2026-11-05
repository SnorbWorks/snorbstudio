"""Ender Studio self-updater: follows the GitHub repo the Pi's copy came from.

The Pi keeps a git checkout (~/ender3-pi, with ~/studio pointing into it).
Every few hours this fetches origin; when there are new commits and the
printer is idle (not printing, heaters off, not slicing) it fast-forwards
and runs studio/deploy/install.sh in its own systemd unit, so restarting
this service doesn't kill the install.  install.sh checks the result and
rolls back to the previous commit if Ender Studio or Klipper won't start.

Publishing an update = push to the repo's master branch.
"""
import json
import os
import pwd
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request

HOME = os.path.expanduser("~")
REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
BRANCH = "master"
DATA = os.path.join(HOME, "printer_data")
SETTINGS = os.path.join(DATA, "studio_settings.json")
LAST_RESULT = os.path.join(DATA, "studio_update.json")    # written by install.sh
LOG = os.path.join(DATA, "logs", "studio_update.log")
MOONRAKER = "http://127.0.0.1:7125"
CHECK_EVERY = 6 * 3600       # fetch from GitHub
POLL = 600                   # look for an idle moment to install
FIRST_CHECK = 120            # after start-up


class UpdateError(Exception):
    pass


def git(*args, timeout=60):
    r = subprocess.run(["git", "-C", REPO] + list(args), capture_output=True,
                       text=True, timeout=timeout)
    if r.returncode:
        msg = " ".join((r.stderr or r.stdout).split())
        raise UpdateError(msg[:300] or "git %s failed" % args[0])
    return r.stdout.strip()


def moonraker(path):
    with urllib.request.urlopen(MOONRAKER + path, timeout=5) as r:
        return json.load(r)["result"]


class Updater:
    def __init__(self, slicing):
        self.slicing = slicing            # () -> True while a slice job runs
        self.lock = threading.Lock()
        self.checking = self.installing = False
        self.error = None
        self.checked = 0
        self.behind = 0
        self.commits = []

    # ------------------------------------------------------------ state
    @property
    def is_git(self):
        return os.path.isdir(os.path.join(REPO, ".git"))

    def settings(self):
        try:
            with open(SETTINGS) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    @property
    def auto(self):
        return self.settings().get("auto_update", True)

    def set_auto(self, on):
        s = self.settings()
        s["auto_update"] = bool(on)
        tmp = SETTINGS + ".tmp"
        with open(tmp, "w") as f:
            json.dump(s, f)
        os.replace(tmp, SETTINGS)

    def version(self):
        try:
            sha, date, subject = git("log", "-1", "--format=%h%x09%cI%x09%s").split("\t", 2)
            return {"sha": sha, "date": date, "subject": subject}
        except (UpdateError, ValueError, OSError):
            return None

    def status(self):
        try:
            with open(LAST_RESULT) as f:
                last = json.load(f)
        except (OSError, ValueError):
            last = None
        url = None
        if self.is_git:
            try:
                url = git("remote", "get-url", "origin")
            except UpdateError:
                pass
        return {"git": self.is_git, "repo": url, "version": self.version(),
                "behind": self.behind, "commits": self.commits,
                "checked": self.checked, "checking": self.checking,
                "installing": self.installing, "error": self.error,
                "auto": self.auto, "last": last}

    # ------------------------------------------------------------ check
    def check(self):
        if not self.is_git:
            raise UpdateError("This copy wasn't installed from GitHub, so it can't update itself.")
        with self.lock:
            if self.checking or self.installing:
                return
            self.checking = True
        try:
            git("fetch", "--quiet", "origin", BRANCH, timeout=120)
            self.behind = int(git("rev-list", "--count", "HEAD..origin/" + BRANCH))
            log = git("log", "-20", "--format=%h%x09%cI%x09%s", "HEAD..origin/" + BRANCH)
            self.commits = [dict(zip(("sha", "date", "subject"), l.split("\t", 2)))
                            for l in log.splitlines() if l]
            self.error = None
        except (UpdateError, subprocess.TimeoutExpired, OSError) as e:
            self.error = "Couldn't check for updates: %s" % e
        finally:
            self.checked = time.time()
            self.checking = False

    # ------------------------------------------------------------ install
    def printer_idle(self, strict):
        """strict (automatic installs): also wait for the heaters to be off,
        so nobody is mid-preheat or loading filament."""
        if self.slicing():
            return False, "a slice is running"
        try:
            info = moonraker("/printer/info")
        except Exception:
            # Moonraker down: nothing can be printing, but only a person
            # should decide to update in that state.
            return (not strict), "can't reach Moonraker"
        if info.get("state") != "ready":
            return True, ""
        try:
            st = moonraker("/printer/objects/query?print_stats=state"
                           "&extruder=target&heater_bed=target")["status"]
        except Exception:
            return False, "can't read the printer state"
        if st.get("print_stats", {}).get("state") in ("printing", "paused"):
            return False, "a print is running"
        if strict and (st.get("extruder", {}).get("target") or
                       st.get("heater_bed", {}).get("target")):
            return False, "the heaters are on"
        return True, ""

    def install(self, manual=False):
        ok, why = self.printer_idle(strict=not manual)
        if not ok:
            raise UpdateError("Not now - %s." % why)
        with self.lock:
            if self.installing:
                raise UpdateError("Already updating.")
            self.installing = True
        try:
            if git("status", "--porcelain", "--untracked-files=no"):
                raise UpdateError("The Pi's copy has local edits - they'd be overwritten, so it won't update.")
            if not int(git("rev-list", "--count", "HEAD..origin/" + BRANCH)):
                raise UpdateError("Already up to date.")
            prev = git("rev-parse", "HEAD")
            git("merge", "--ff-only", "--quiet", "origin/" + BRANCH)
            # Run a copy of install.sh: the rollback rewrites the checkout,
            # and a shell script being edited while it runs misbehaves.
            fd, script = tempfile.mkstemp(prefix="ender-studio-install-", suffix=".sh")
            os.close(fd)
            shutil.copy(os.path.join(REPO, "studio", "deploy", "install.sh"), script)
            os.makedirs(os.path.dirname(LOG), exist_ok=True)
            with open(LOG, "a") as f:
                f.write("\n==== %s update %s -> %s\n" % (
                    time.strftime("%Y-%m-%d %H:%M:%S"), prev[:7], git("rev-parse", "--short", "HEAD")))
            user = pwd.getpwuid(os.getuid()).pw_name
            cmd = ["sudo", "-n", "systemd-run", "--quiet", "--collect",
                   "--unit=ender-studio-update-%d" % int(time.time()),
                   "-p", "User=" + user,
                   "-p", "StandardOutput=append:" + LOG,
                   "-p", "StandardError=append:" + LOG,
                   "--setenv=REPO=" + REPO, "--setenv=PREV=" + prev,
                   "/bin/sh", script]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if r.returncode:
                git("reset", "--hard", "--quiet", prev)
                raise UpdateError("Couldn't start the installer: %s" % (r.stderr.strip() or r.returncode))
            self.behind, self.commits = 0, []
            # install.sh restarts this service; until then report "installing".
        except Exception:
            self.installing = False
            raise

    def known_bad(self):
        """The waiting update already failed and was rolled back: don't
        retry it on its own (a newer push, or Install now, still works)."""
        try:
            with open(LAST_RESULT) as f:
                bad = json.load(f).get("bad")
            return bool(bad) and git("rev-parse", "origin/" + BRANCH).startswith(bad)
        except (OSError, ValueError, UpdateError):
            return False

    # ------------------------------------------------------------ loop
    def run_forever(self):
        time.sleep(FIRST_CHECK)
        while True:
            try:
                if self.is_git:
                    if time.time() - self.checked > CHECK_EVERY:
                        self.check()
                    if self.behind and self.auto and not self.installing \
                            and not self.known_bad():
                        try:
                            self.install(manual=False)
                        except UpdateError as e:
                            if not str(e).startswith("Not now"):
                                self.error = str(e)   # (not idle: retry later)
            except Exception as e:        # never let the loop die
                self.error = str(e)
            time.sleep(POLL)

    def start(self):
        threading.Thread(target=self.run_forever, daemon=True).start()
