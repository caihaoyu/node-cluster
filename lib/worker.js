/* vim: set expandtab tabstop=2 shiftwidth=2 foldmethod=marker: */

var Socket  = require('net').Socket;

var STATUS  = require(__dirname + '/common.js').STATUS;
var MESSAGE = require(__dirname + '/common.js').MESSAGE;
var Debug   = require(__dirname + '/common.js').debug;
var Listen  = require(__dirname + '/common.js').listen;

var isArray = Array.isArra

var NOTICE  = function (name, message) {
  Debug('worker', Array.prototype.join.call(arguments, ' '));
};

/* {{{ private function _send() */
/**
 * 向父进程发送消息
 *
 * @access private
 * @param {Number} type: see MESSAGE
 * @param {Object} data
 */
if (!process.hasOwnProperty('send')) {
  var _send = function (type, data) {
    NOTICE('_SEND', JSON.stringify({
      'type'    : type,
      'data'    : data,
    }));
  };
} else {
  var _send = function (type, data) {
    try {
      process.send({
        'type'  : type,
        'data'  : data,
      });
    } catch (e) {
      NOTICE('ERROR', e.stack);
      process.exit(0);
    }
  };
}
/* }}} */

/* {{{ private function _accept() */
var _accept = function (handle, callback) {
  if (!handle) {
    return;
  }

  if (!callback) {
    handle.close();
    handle  = null;
    return;
  }

  var _me   = new Socket({
    'handle'  : handle,
  });

  _me.readable  = true;
  _me.writable  = true;
  _me.resume();
  _me.on('error', function (error) {
    NOTICE('SOCKET', error.stack);
  });
  _me.emit('connect');
  callback(_me);
};
/* }}} */

exports.create  = function (options) {

  var _me   = {};

  /* {{{ 控制参数 */

  var _conf = {
    'heartbeat_interval' : 2000,
    'terminate_timeout'  : 1000,
  };
  for (var i in options) {
    _conf[i] = options[i];
  }
  if (_conf.heartbeat_interval > 30000) {
    _conf.heartbeat_interval = 30000;
  }
  /* }}} */

  /**
   * @心跳数据
   */
  var mstat = {
    'status'    : STATUS.PENDING,
    'scores'    : 0,
  };

  /**
   * @其他worker发来的消息处理函数
   */
  var onmsg = [];

  /**
   * @worker直听模式
   */
  var _listener = {};

  /* {{{ 心跳方法 */

  var heartbeat = function () {
    mstat.mem   = process.memoryUsage();
    _send(MESSAGE.STATUS, mstat);
  };

  /* }}} */

  /* {{{ 信号处理 */

  process.on('SIGHUB',  function () {});
  process.on('SIGTERM', function () {
    mstat.status = STATUS.STOPING;
    for (var idx in _listener) {
      var _fd = _listener[idx];
      _fd.close();
      _fd = null;
    }
    _listener   = {};

    setTimeout(function () {
      process.exit(0);
    }, _conf.terminate_timeout);
  });
  process.on('exit',    function () {
    NOTICE('terminated after ' + Number(process.uptime()).toFixed(3) + ' seconds.');
  });

  /* }}} */

  /* {{{ public function ready() */
  /**
   * worker进入运行状态
   */
  _me.ready = function (callback) {
    mstat   = {
      'status'  : STATUS.RUNNING,
      'scores'  : 0,
    };
    heartbeat();
    setInterval(heartbeat, _conf.heartbeat_interval);

    process.on('message', function (msg, handle) {
      if (!msg || !msg.type) {
        return;
      }

      switch (msg.type) {
        case MESSAGE.WAKEUP:
          if (STATUS.RUNNING === mstat.status) {
            _send(MESSAGE.GET_FD);
          }
          break;

        case MESSAGE.REQ_FD:
          mstat.scores++;
          _accept(handle, callback);
          if (STATUS.RUNNING === mstat.status && msg.data) {
            process.nextTick(function () {
              _send(MESSAGE.GET_FD);
            });
          }
          break;

        case MESSAGE.LISTEN:
          var _addr = msg.data;
          if (_addr && !_listener[_addr]) {
            _listener[_addr] = Listen(_addr, function (handle) {
              mstat.scores++;
              _accept(handle, callback);
            });
            NOTICE('direct listen at "' + _addr + '"');
          }
          break;

        case MESSAGE.COMMAND:
          onmsg.forEach(function (cb) {
            if (cb && msg.data) {
              cb(msg.data, msg.from, msg.pid);
            }
          });
          break;

        case MESSAGE.BOARDCAST:
          if (msg.data) {
            if (msg.data.event) {
              var _a = [msg.data.event];
              [].push.apply(_a, msg.data.data);
              _me._emit.aplly(_me, _a);
            } else {
              onmsg.forEach(function (cb) {
                if (cb && msg.data) {
                  cb(msg.data, msg.from, msg.pid);
                }
              });
            }
          }
          break;

        default:
          break;
      }
    });

    return _me;
  };
  /* }}} */

  /* {{{ public function onmessage() */
  /**
   * 消息处理函数
   *
   * @access public
   */
  _me.onmessage = function (cb) {
    if (!cb) {
      onmsg = [];
    } else {
      onmsg.push(cb);
    }
  };
  /* }}} */

  /* {{{ public function sendto() */
  /**
   * 向其他进程发送消息
   *
   * @access public
   * @param {String} who, process name
   * @param {Object} data
   */
  _me.sendto    = function (who, data) {
    _send(MESSAGE.SENDTO, {
      'name' : who,
      'data' : data,
    });
  };
  /* }}} */

  /* {{{ public function boardcast() */
  /**
   * 发送命令消息到其他进程
   *
   * @access public
   * @param {String} data
   */
  _me.boardcast    = function(data) {
    _send(MESSAGE.BOARDCAST, {
      'data' : data
    });
  };
  /* }}} */

  /* {{{ public function on() */
  /**
   * 绑定自定义通讯事件
   *
   * @access public
   * @param {String} event 事件名称
   * @param {Function} handle 事件响应器
   */
  _me.on    = function(event, handle) {
    if (!_me._events) _me._events = {};
    if (!_me._events[event])
      _me._events[event] = [handle]
    else
      _me._events[event].push(handle);
  };
  /* }}} */

  /* {{{ public function emit() */
  /**
   * 触发自定义通讯事件
   *
   * @access public
   * @param {String} event 事件名称
   */
  _me.emit    = function() {
    var event = arguments[0];

    var l = arguments.length;
    var args = new Array(l - 1);
    for (var i = 1; i < l; i++) args[i - 1] = arguments[i];
    _me.boardcast({
      'event': event,
      'data': args
    });
    return true;
  };
  /* }}} */

  /* {{{ public function _emit() */
  /**
   * 触发自定义事件
   *
   * @access public
   * @param {String} event 事件名称
   */
  _me._emit    = function() {
    var event = arguments[0];
    if (!_me._events) return false;
    var handler = this._events[type];
    if (!handler) return false;

    if (isArray(handler)) {
      var l = arguments.length;
      var args = new Array(l - 1);
      for (var i = 1; i < l; i++) args[i - 1] = arguments[i];
      var listeners = handler.slice();
      for (var i = 0, l = listeners.length; i < l; i++) {
        listeners[i].apply(this, args);
      }
      return true;
    } else {
      return false;
    }
  };
  /* }}} */

  /* {{{ public function reload() */
  /**
   * reload其他进程
   *
   * @access public
   * @param {String} who, process name
   */
  _me.reload    = function (who) {
    _send(MESSAGE.RELOAD, {
      'name' : who,
    });
  };
  /* }}} */

  return _me;

};
