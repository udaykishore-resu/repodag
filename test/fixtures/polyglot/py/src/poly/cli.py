"""Command line. Not an import: from poly import nothing"""
import os

import requests

from . import core
from .util import helpers
from .util.helpers import (
    shout,
)


def main():
    return core.run(helpers.clean(shout(os.getcwd()))), requests
