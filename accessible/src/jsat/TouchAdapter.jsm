/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

this.EXPORTED_SYMBOLS = ['TouchAdapter'];

Cu.import('resource://gre/modules/accessibility/Utils.jsm');

// We should not be emitting explore events more than 10 times a second.
// It is granular enough to feel natural, and it does not hammer the CPU.
const EXPLORE_THROTTLE = 100;

this.TouchAdapter = {
  // minimal swipe distance in inches
  SWIPE_MIN_DISTANCE: 0.4,

  // maximum duration of swipe
  SWIPE_MAX_DURATION: 400,

  // how straight does a swipe need to be
  SWIPE_DIRECTNESS: 1.2,

  // maximum consecutive
  MAX_CONSECUTIVE_GESTURE_DELAY: 400,

  // delay before tap turns into dwell
  DWELL_THRESHOLD: 500,

  // delay before distinct dwell events
  DWELL_REPEAT_DELAY: 300,

  // maximum distance the mouse could move during a tap in inches
  TAP_MAX_RADIUS: 0.2,

  // The virtual touch ID generated by an Android hover event.
  HOVER_ID: 'hover',

  start: function TouchAdapter_start() {
    Logger.info('TouchAdapter.start');

    this._touchPoints = {};
    this._dwellTimeout = 0;
    this._prevGestures = {};
    this._lastExploreTime = 0;
    this._dpi = Utils.win.QueryInterface(Ci.nsIInterfaceRequestor).
      getInterface(Ci.nsIDOMWindowUtils).displayDPI;

    let target = Utils.win;

    if (Utils.MozBuildApp == 'b2g') {
      this.glass = Utils.win.document.
        createElementNS('http://www.w3.org/1999/xhtml', 'div');
      this.glass.id = 'accessfu-glass';
      Utils.win.document.documentElement.appendChild(this.glass);
      target = this.glass;
    }

    target.addEventListener('mousemove', this, true, true);
    target.addEventListener('mouseenter', this, true, true);
    target.addEventListener('mouseleave', this, true, true);

    target.addEventListener('touchend', this, true, true);
    target.addEventListener('touchmove', this, true, true);
    target.addEventListener('touchstart', this, true, true);

    if (Utils.OS != 'Android')
      Mouse2Touch.start();
  },

  stop: function TouchAdapter_stop() {
    Logger.info('TouchAdapter.stop');

    let target = Utils.win;

    if (Utils.MozBuildApp == 'b2g') {
      target = this.glass;
      this.glass.parentNode.removeChild(this.glass);
    }

    target.removeEventListener('mousemove', this, true, true);
    target.removeEventListener('mouseenter', this, true, true);
    target.removeEventListener('mouseleave', this, true, true);

    target.removeEventListener('touchend', this, true, true);
    target.removeEventListener('touchmove', this, true, true);
    target.removeEventListener('touchstart', this, true, true);

    if (Utils.OS != 'Android')
      Mouse2Touch.stop();
  },

  handleEvent: function TouchAdapter_handleEvent(aEvent) {
    if (this._delayedEvent) {
      Utils.win.clearTimeout(this._delayedEvent);
      delete this._delayedEvent;
    }

    let changedTouches = aEvent.changedTouches || [aEvent];

    // XXX: Until bug 77992 is resolved, on desktop we get microseconds
    // instead of milliseconds.
    let timeStamp = (Utils.OS == 'Android') ? aEvent.timeStamp : Date.now();
    switch (aEvent.type) {
      case 'mouseenter':
      case 'touchstart':
        for (var i = 0; i < changedTouches.length; i++) {
          let touch = changedTouches[i];
          let touchPoint = new TouchPoint(touch, timeStamp, this._dpi);
          let identifier = (touch.identifier == undefined) ?
            this.HOVER_ID : touch.identifier;
          this._touchPoints[identifier] = touchPoint;
          this._lastExploreTime = timeStamp + this.SWIPE_MAX_DURATION;
        }
        this._dwellTimeout = Utils.win.setTimeout(
          (function () {
             this.compileAndEmit(timeStamp + this.DWELL_THRESHOLD);
           }).bind(this), this.DWELL_THRESHOLD);
        break;
      case 'mousemove':
      case 'touchmove':
        for (var i = 0; i < changedTouches.length; i++) {
          let touch = changedTouches[i];
          let identifier = (touch.identifier == undefined) ?
            this.HOVER_ID : touch.identifier;
          let touchPoint = this._touchPoints[identifier];
          if (touchPoint)
            touchPoint.update(touch, timeStamp);
        }
        if (timeStamp - this._lastExploreTime >= EXPLORE_THROTTLE) {
          this.compileAndEmit(timeStamp);
          this._lastExploreTime = timeStamp;
        }
        break;
      case 'mouseleave':
      case 'touchend':
        for (var i = 0; i < changedTouches.length; i++) {
          let touch = changedTouches[i];
          let identifier = (touch.identifier == undefined) ?
            this.HOVER_ID : touch.identifier;
          let touchPoint = this._touchPoints[identifier];
          if (touchPoint) {
            touchPoint.update(touch, timeStamp);
            touchPoint.finish();
          }
        }
        this.compileAndEmit(timeStamp);
        break;
    }

    aEvent.preventDefault();
  },

  cleanupTouches: function cleanupTouches() {
    for (var identifier in this._touchPoints) {
      if (!this._touchPoints[identifier].done)
        continue;

      delete this._touchPoints[identifier];
    }
  },

  compile: function TouchAdapter_compile(aTime) {
    let multiDetails = {};

    // Compound multiple simultaneous touch gestures.
    for (let identifier in this._touchPoints) {
      let touchPoint = this._touchPoints[identifier];
      let details = touchPoint.compile(aTime);

      if (!details)
        continue;

      details.touches = [identifier];

      let otherTouches = multiDetails[details.type];
      if (otherTouches) {
        otherTouches.touches.push(identifier);
        otherTouches.startTime =
          Math.min(otherTouches.startTime, touchPoint.startTime);
      } else {
        details.startTime = touchPoint.startTime;
        details.endTime = aTime;
        multiDetails[details.type] = details;
      }
    }

    // Compound multiple consecutive touch gestures.
    for each (let details in multiDetails) {
      let idhash = details.touches.slice().sort().toString();
      let prevGesture = this._prevGestures[idhash];

      if (prevGesture) {
        // The time delta is calculated as the period between the end of the
        // last gesture and the start of this one.
        let timeDelta = details.startTime - prevGesture.endTime;
        if (timeDelta > this.MAX_CONSECUTIVE_GESTURE_DELAY) {
          delete this._prevGestures[idhash];
        } else {
          let sequence = prevGesture.type + '-' + details.type;
          switch (sequence) {
            case 'tap-tap':
              details.type = 'doubletap';
              break;
            case 'doubletap-tap':
              details.type = 'tripletap';
              break;
            case 'tap-dwell':
              details.type = 'taphold';
              break;
            case 'explore-explore':
              details.deltaX = details.x - prevGesture.x;
              details.deltaY = details.y - prevGesture.y;
              break;
          }
        }
      }

      this._prevGestures[idhash] = details;
    }

    Utils.win.clearTimeout(this._dwellTimeout);
    this.cleanupTouches();

    return multiDetails;
  },

  emitGesture: function TouchAdapter_emitGesture(aDetails) {
    let emitDelay = 0;

    // Unmutate gestures we are getting from Android when EBT is enabled.
    // Two finger gestures are translated to one. Double taps are translated
    // to single taps.
    if (Utils.MozBuildApp == 'mobile/android' &&
        Utils.AndroidSdkVersion >= 14 &&
        aDetails.touches[0] != this.HOVER_ID) {
      if (aDetails.touches.length == 1) {
        if (aDetails.type == 'tap') {
          emitDelay = 50;
          aDetails.type = 'doubletap';
        } else {
          aDetails.touches.push(this.HOVER_ID);
        }
      }
    }

    let emit = function emit() {
      let evt = Utils.win.document.createEvent('CustomEvent');
      evt.initCustomEvent('mozAccessFuGesture', true, true, aDetails);
      Utils.win.dispatchEvent(evt);
      delete this._delayedEvent;
    }.bind(this);

    if (emitDelay) {
      this._delayedEvent = Utils.win.setTimeout(emit, emitDelay);
    } else {
      emit();
    }
  },

  compileAndEmit: function TouchAdapter_compileAndEmit(aTime) {
    for each (let details in this.compile(aTime)) {
      this.emitGesture(details);
    }
  }
};

/***
 * A TouchPoint represents a single touch from the moment of contact until it is
 * lifted from the surface. It is capable of compiling gestures from the scope
 * of one single touch.
 */
function TouchPoint(aTouch, aTime, aDPI) {
  this.startX = this.x = aTouch.screenX;
  this.startY = this.y = aTouch.screenY;
  this.startTime = aTime;
  this.distanceTraveled = 0;
  this.dpi = aDPI;
  this.done = false;
}

TouchPoint.prototype = {
  update: function TouchPoint_update(aTouch, aTime) {
    let lastX = this.x;
    let lastY = this.y;
    this.x = aTouch.screenX;
    this.y = aTouch.screenY;
    this.time = aTime;

    this.distanceTraveled += this.getDistanceToCoord(lastX, lastY);
  },

  getDistanceToCoord: function TouchPoint_getDistanceToCoord(aX, aY) {
    return Math.sqrt(Math.pow(this.x - aX, 2) + Math.pow(this.y - aY, 2));
  },

  finish: function TouchPoint_finish() {
    this.done = true;
  },

  /**
   * Compile a gesture from an individual touch point. This is used by the
   * TouchAdapter to compound multiple single gestures in to higher level
   * gestures.
   */
  compile: function TouchPoint_compile(aTime) {
    let directDistance = this.directDistanceTraveled;
    let duration = aTime - this.startTime;

    // To be considered a tap/dwell...
    if ((this.distanceTraveled / this.dpi) < TouchAdapter.TAP_MAX_RADIUS) { // Didn't travel
      if (duration < TouchAdapter.DWELL_THRESHOLD) {
        // Mark it as done so we don't use this touch for another gesture.
        this.finish();
        return {type: 'tap', x: this.startX, y: this.startY};
      } else if (!this.done && duration == TouchAdapter.DWELL_THRESHOLD) {
        return {type: 'dwell', x: this.startX, y: this.startY};
      }
    }

    // To be considered a swipe...
    if (duration <= TouchAdapter.SWIPE_MAX_DURATION && // Quick enough
        (directDistance / this.dpi) >= TouchAdapter.SWIPE_MIN_DISTANCE && // Traveled far
        (directDistance * 1.2) >= this.distanceTraveled) { // Direct enough

      let swipeGesture = {x1: this.startX, y1: this.startY,
                          x2: this.x, y2: this.y};
      let deltaX = this.x - this.startX;
      let deltaY = this.y - this.startY;

      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        // Horizontal swipe.
        if (deltaX > 0)
          swipeGesture.type = 'swiperight';
        else
          swipeGesture.type = 'swipeleft';
      } else if (Math.abs(deltaX) < Math.abs(deltaY)) {
        // Vertical swipe.
        if (deltaY > 0)
          swipeGesture.type = 'swipedown';
        else
          swipeGesture.type = 'swipeup';
      } else {
        // A perfect 45 degree swipe?? Not in our book.
          return null;
      }

      this.finish();

      return swipeGesture;
    }

    // To be considered an explore...
    if (!this.done &&
        duration > TouchAdapter.SWIPE_MAX_DURATION &&
        (this.distanceTraveled / this.dpi) > TouchAdapter.TAP_MAX_RADIUS) {
      return {type: 'explore', x: this.x, y: this.y};
    }

    return null;
  },

  get directDistanceTraveled() {
    return this.getDistanceToCoord(this.startX, this.startY);
  }
};

var Mouse2Touch = {
  _MouseToTouchMap: {
    mousedown: 'touchstart',
    mouseup: 'touchend',
    mousemove: 'touchmove'
  },

  start: function Mouse2Touch_start() {
    Utils.win.addEventListener('mousedown', this, true, true);
    Utils.win.addEventListener('mouseup', this, true, true);
    Utils.win.addEventListener('mousemove', this, true, true);
  },

  stop: function Mouse2Touch_stop() {
    Utils.win.removeEventListener('mousedown', this, true, true);
    Utils.win.removeEventListener('mouseup', this, true, true);
    Utils.win.removeEventListener('mousemove', this, true, true);
  },

  handleEvent: function Mouse2Touch_handleEvent(aEvent) {
    if (aEvent.buttons == 0)
      return;

    let name = this._MouseToTouchMap[aEvent.type];
    let evt = Utils.win.document.createEvent("touchevent");
    let points = [Utils.win.document.createTouch(
                    Utils.win, aEvent.target, 0,
                    aEvent.pageX, aEvent.pageY, aEvent.screenX, aEvent.screenY,
                    aEvent.clientX, aEvent.clientY, 1, 1, 0, 0)];

    // Simulate another touch point at a 5px offset when ctrl is pressed.
    if (aEvent.ctrlKey)
      points.push(Utils.win.document.createTouch(
                    Utils.win, aEvent.target, 1,
                    aEvent.pageX + 5, aEvent.pageY + 5,
                    aEvent.screenX + 5, aEvent.screenY + 5,
                    aEvent.clientX + 5, aEvent.clientY + 5,
                    1, 1, 0, 0));

    // Simulate another touch point at a -5px offset when alt is pressed.
    if (aEvent.altKey)
      points.push(Utils.win.document.createTouch(
                    Utils.win, aEvent.target, 2,
                    aEvent.pageX - 5, aEvent.pageY - 5,
                    aEvent.screenX - 5, aEvent.screenY - 5,
                    aEvent.clientX - 5, aEvent.clientY - 5,
                    1, 1, 0, 0));

    let touches = Utils.win.document.createTouchList(points);
    if (name == "touchend") {
      let empty = Utils.win.document.createTouchList();
      evt.initTouchEvent(name, true, true, Utils.win, 0,
                         false, false, false, false, empty, empty, touches);
    } else {
      evt.initTouchEvent(name, true, true, Utils.win, 0,
                         false, false, false, false, touches, touches, touches);
    }
    aEvent.target.dispatchEvent(evt);
    aEvent.preventDefault();
    aEvent.stopImmediatePropagation();
  }
};
