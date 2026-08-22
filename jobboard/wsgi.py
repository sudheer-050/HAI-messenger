from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.exceptions import NotFound
from app import app

application = DispatcherMiddleware(NotFound(), {"/jobs": app})
