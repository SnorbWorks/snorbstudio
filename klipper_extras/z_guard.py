# Emergency stop from a spare Z switch while homing or probing
#
# Klipper only watches the endstop of the axis being homed, so a second
# switch is normally ignored.  This listens to the switch directly (button
# events run in the reactor, so they arrive mid-move) and shuts the printer
# down if it is pressed while a homing/probing move is running.
#
# [z_guard]
# pin: ^PA7
# mode: homing     # homing = armed only during homing/probing moves
#                  # always = armed all the time (switch must sit below Z=0)
import logging

class ZGuard:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.mode = config.getchoice('mode', {'homing': 'homing',
                                              'always': 'always'}, 'homing')
        self.homing = False
        self.pressed = False
        buttons = self.printer.load_object(config, 'buttons')
        buttons.register_buttons([config.get('pin')], self._button)
        self.printer.register_event_handler("homing:homing_move_begin",
                                            self._move_begin)
        self.printer.register_event_handler("homing:homing_move_end",
                                            self._move_end)
        gcode = self.printer.lookup_object('gcode')
        gcode.register_command('QUERY_Z_GUARD', self.cmd_QUERY_Z_GUARD,
                               desc="Report the Z guard switch state")
    def _armed(self):
        return self.mode == 'always' or self.homing
    def _move_begin(self, hmove):
        if self.pressed:
            raise self.printer.command_error(
                "Z guard switch is pressed - refusing to home/probe")
        self.homing = True
    def _move_end(self, hmove):
        self.homing = False
    def _button(self, eventtime, state):
        self.pressed = bool(state)
        logging.info("z_guard: switch %s (armed=%s)",
                     "pressed" if state else "released", self._armed())
        if state and self._armed():
            self.printer.invoke_shutdown(
                "Z guard: Z switch pressed during homing/probing")
    def get_status(self, eventtime):
        return {'pressed': self.pressed, 'armed': self._armed(),
                'mode': self.mode}
    def cmd_QUERY_Z_GUARD(self, gcmd):
        gcmd.respond_info("Z guard: switch %s, mode %s, armed %s" % (
            "PRESSED" if self.pressed else "released", self.mode,
            self._armed()))

def load_config(config):
    return ZGuard(config)
