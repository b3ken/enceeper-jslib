//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A wrapper around the enceeper service (API calls)
//
// Copyright (C) 2019 Vassilis Poursalidis (poursal@gmail.com)
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with this program. If
// not, see <https://www.gnu.org/licenses/>.
//

// Check our requirements
if (typeof enceeper !== 'object') {
  throw new Error('You need to include the enceeper base file!')
}
if (typeof enceeper.network !== 'function') {
  throw new Error('You need to include the enceeper.network JS file!')
}
if (typeof enceeper.srp6a !== 'function') {
  throw new Error('You need to include the enceeper.srp6a JS file!')
}
if (typeof enceeper.crypto !== 'function') {
  throw new Error('You need to include the enceeper.crypto JS file!')
}
if (typeof ''.normalize !== 'function') {
  throw new Error('You need to include the unorm js file!')
}
if (typeof sjcl !== 'object') {
  throw new Error('You need to include the SJCL JS file!')
}
if (typeof InvalidArgumentException === 'undefined') {
  throw new Error('You need to include the enceeper exceptions JS file!')
}

// A wrapper around the enceeper service
enceeper.api = function (email, pass, successCallback, failureCallback) {
  if (typeof email !== 'string') {
    throw new InvalidArgumentException('You must provide your email.')
  }
  if (typeof pass !== 'string') {
    throw new InvalidArgumentException('You must provide your password.')
  }

  this._email = email
  this._pass = pass.normalize('NFKC')

  // Our libraries
  this._crypto = null // We will instantiate once we are logged
  this._srp6a = new enceeper.srp6a(this._email, this._pass)
  this._network = new enceeper.network('https://www.enceeper.com/api/v1/', successCallback, failureCallback)

  // The callbacks
  this._successCallback = successCallback
  this._failureCallback = failureCallback

  // Internal vars
  this._srp6a_ref = null
  this._srp6a_salt = null
  this._srp6a_B = null
  this._scrypt_salt = null

  // Consts
  this.notificationType = {
    NOTHING: 0,
    REPORT: 1,
    APPROVE: 2
  }
  this.keyStatus = {
    ENABLED: 0,
    DISABLED: 1
  }
}

enceeper.api.prototype = {
  test: function (successCallback, failureCallback) {
    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('GET', '', null, successCallback, failureCallback)
  },

  register: function (successCallback, failureCallback) {
    var self = this

    this._resetState(this)

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._srp6a.register(function (salt, verifier) {
      var scryptSalt = sjcl.codec.hex.fromBits(sjcl.random.randomWords(8))
      var regCrypto = new enceeper.crypto(self._pass, scryptSalt)

      // If we change scrypt or keys we must update: login, signin and password
      var register = {
        email: self._email,
        auth: {
          srp6a: {
            salt: salt,
            verifier: verifier
          },
          scrypt: {
            salt: scryptSalt
          },
          keys: regCrypto.createAccountKeys()
        }
      }

      self._network.call('POST', 'user', register, successCallback, failureCallback)
    })
  },

  challenge: function (successCallback, failureCallback) {
    var self = this

    if (this._crypto !== null) {
      throw new InvalidStateException('You are already logged in. Please logout first.')
    }
    if (this._srp6a_ref !== null) {
      throw new InvalidStateException('You already have a challenge, try to login or use logout first.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('POST', 'user/challenge', { email: this._email }, function (data) {
      // First alter our internal state
      self._srp6a_ref = data.result.srp6a.ref
      self._srp6a_salt = data.result.srp6a.salt
      self._srp6a_B = data.result.srp6a.B

      // Then execute the callback
      successCallback(data)
    }, failureCallback)
  },

  login: function (successCallback, failureCallback) {
    var self = this

    if (this._crypto !== null) {
      throw new InvalidStateException('You are already logged in. Please logout first.')
    }
    if (this._srp6a_ref === null) {
      throw new InvalidStateException('You must call challenge first to init the login procedure.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._srp6a.step1(this._srp6a_salt, this._srp6a_B, function (cPubKey, m1) {
      var login = {
        srp6a: {
          A: cPubKey,
          M1: m1,
          ref: self._srp6a_ref
        }
      }

      self._network.call('POST', 'user/login', login, function (data) {
        // Invalidate ref
        self._srp6a_ref = null
        self._srp6a_salt = null
        self._srp6a_B = null

        // Check the server proof and we are done!
        if (!self._srp6a.step2(data.result.srp6a.M2)) {
          failureCallback(500, 'Server authentication failed')
          return
        }

        // Calc crypto key
        self._scrypt_salt = data.result.scrypt.salt
        self._crypto = new enceeper.crypto(self._pass, self._scrypt_salt)
        self._crypto.restoreAccountKeys(data.result.keys)

        // Set authToken to network library
        self._network.setAuthToken(data.result.enceeper.authToken)

        // Then execute the callback
        successCallback(data)
      }, failureCallback)
    })
  },

  signin: function (successCallback, failureCallback) {
    var self = this

    if (this._crypto !== null) {
      throw new InvalidStateException('You are already logged in. Please logout first.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._bundledSRP6a(this, this._srp6a, function (data) {
      // Calc crypto key
      self._scrypt_salt = data.result.scrypt.salt
      self._crypto = new enceeper.crypto(self._pass, self._scrypt_salt)
      self._crypto.restoreAccountKeys(data.result.keys)

      // Set authToken to network library
      self._network.setAuthToken(data.result.enceeper.authToken)

      // Then execute the callback
      successCallback(data)
    }, failureCallback)
  },

  password: function (oldPassword, newPassword, successCallback, failureCallback) {
    var self = this
    var newSRP6a, newCrypto, kek

    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }

    if (typeof oldPassword !== 'string') {
      throw new InvalidArgumentException('You must provide your current password.')
    }
    if (typeof newPassword !== 'string') {
      throw new InvalidArgumentException('You must provide your new password.')
    }

    // Normalize prior to usage
    oldPassword = oldPassword.normalize('NFKC')
    newPassword = newPassword.normalize('NFKC')

    if (oldPassword !== this._pass) {
      throw new InvalidArgumentException('The current password you have entered is incorrect.')
    }
    if (oldPassword === newPassword) {
      throw new InvalidArgumentException('Your current and new password must be different.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    // Create the new values
    newSRP6a = new enceeper.srp6a(this._email, newPassword)
    newCrypto = new enceeper.crypto(newPassword, this._scrypt_salt)
    kek = newCrypto.encryptKEK(this._crypto.getKEK())

    newSRP6a.register(function (salt, verifier) {
      var update = {
        srp6a: {
          salt: salt,
          verifier: verifier
        },
        keys: {
          kek: kek
        }
      }

      self._network.call('PUT', 'user', update, function (data) {
        // Chain with challenge and then login
        self._bundledSRP6a(self, newSRP6a, function (data) {
          // Calc crypto key
          self._pass = newPassword
          self._srp6a = newSRP6a
          self._crypto = newCrypto
          self._crypto.restoreAccountKeys(data.result.keys)

          // Set authToken to network library
          self._network.setAuthToken(data.result.enceeper.authToken)

          // Then execute the callback
          successCallback(data)
        }, failureCallback)
      }, failureCallback)
    })
  },

  delete: function (successCallback, failureCallback) {
    var self = this

    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    self._network.call('DELETE', 'user', null, function (data) {
      // Logout
      self._resetState(self)

      successCallback(data)
    }, failureCallback)
  },

  keys: function (successCallback, failureCallback) {
    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('GET', 'user/keys', null, successCallback, failureCallback)
  },

  addKey: function (meta, value, successCallback, failureCallback) {
    var key

    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    key = this._crypto.createKey(meta, value)

    this._network.call('POST', 'user/keys', key, successCallback, failureCallback)
  },

  deleteKey: function (keyId, successCallback, failureCallback) {
    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof keyId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the key Id.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('DELETE', 'user/keys/' + keyId, null, successCallback, failureCallback)
  },

  updateKey: function (keyId, slot0, meta, value, status, successCallback, failureCallback) {
    var key

    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof keyId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the key Id.')
    }
    if (typeof status !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the status parameter.')
    }
    if (!this._checkValueInList(status, this.keyStatus)) {
      throw new InvalidArgumentException('You must select one of the available keyStatus values.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    key = this._crypto.updateKey(slot0, meta, value)
    key.status = status

    this._network.call('PUT', 'user/keys/' + keyId, key, successCallback, failureCallback)
  },

  addSlot: function (keyId, slot0, newPass, notify, successCallback, failureCallback) {
    var key

    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof keyId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the key Id.')
    }
    if (typeof notify !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the notify parameter.')
    }
    if (!this._checkValueInList(notify, this.notificationType)) {
      throw new InvalidArgumentException('You must select one of the available notificationType values.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    key = {
      value: this._crypto.addSlot(slot0, newPass),
      notify: notify
    }

    this._network.call('POST', 'user/keys/' + keyId + '/slots', key, successCallback, failureCallback)
  },

  updateSlot: function (keyId, slotId, slot0, newPass, notify, status, successCallback, failureCallback) {
    var key

    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof keyId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the key Id.')
    }
    if (typeof slotId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the slot Id.')
    }
    if (typeof notify !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the notify parameter.')
    }
    if (!this._checkValueInList(notify, this.notificationType)) {
      throw new InvalidArgumentException('You must select one of the available notificationType values.')
    }
    if (typeof status !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the status parameter.')
    }
    if (!this._checkValueInList(status, this.keyStatus)) {
      throw new InvalidArgumentException('You must select one of the available keyStatus values.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    key = {
      notify: notify,
      status: status
    }

    if (newPass !== null) {
      key.value = this._crypto.addSlot(slot0, newPass)
    }

    this._network.call('PUT', 'user/keys/' + keyId + '/slots/' + slotId, key, successCallback, failureCallback)
  },

  deleteSlot: function (keyId, slotId, successCallback, failureCallback) {
    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof keyId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the key Id.')
    }
    if (typeof slotId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the slot Id.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('DELETE', 'user/keys/' + keyId + '/slots/' + slotId, null, successCallback, failureCallback)
  },

  findUser: function (email, successCallback, failureCallback) {
    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof email !== 'string') {
      throw new InvalidArgumentException('You must provide the email of the user to share with.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('POST', 'user/search', { 'email': email }, successCallback, failureCallback)
  },

  createShare: function (keyId, slot0, email, pubKey, successCallback, failureCallback) {
    var share

    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof keyId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the key Id.')
    }
    if (typeof email !== 'string') {
      throw new InvalidArgumentException('You must provide the email of the user to share with.')
    }

    share = {
      email: email,
      slot: this._crypto.createShareSlot(slot0, pubKey)
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('POST', 'user/keys/' + keyId + '/share', share, successCallback, failureCallback)
  },

  deleteShare: function (shareId, successCallback, failureCallback) {
    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof shareId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the share Id.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('DELETE', 'user/keys/shares/' + shareId, null, successCallback, failureCallback)
  },

  acceptShare: function (shareId, slot, pubKey, successCallback, failureCallback) {
    if (this._crypto === null) {
      throw new InvalidStateException('You must login first.')
    }
    if (typeof shareId !== 'number') {
      throw new InvalidArgumentException('You must provide a valid value for the share Id.')
    }

    successCallback = successCallback || this._successCallback || this._defaultCallback
    failureCallback = failureCallback || this._failureCallback || this._defaultCallback

    this._network.call('POST', 'user/keys/shares/' + shareId, {
      slot: this._crypto.acceptShareSlot(slot, pubKey)
    }, successCallback, failureCallback)
  },

  logout: function () {
    this._srp6a_ref = null
    this._resetState(this)
  },

  _defaultCallback: function () {
    throw new InvalidArgumentException('You must provide callbacks during object creation or when calling a method.')
  },

  _resetState: function (self) {
    self._crypto = null
    self._srp6a = new enceeper.srp6a(self._email, self._pass)
    self._network.resetAuthToken()
  },

  _checkValueInList: function (value, list) {
    return (list.indexOf(value) > -1)
  },

  _bundledSRP6a: function (self, srp6a, successCallback, failureCallback) {
    // Using from self: _network and _email
    self._network.call('POST', 'user/challenge', { email: self._email }, function (dataStep1) {
      srp6a.step1(dataStep1.result.srp6a.salt, dataStep1.result.srp6a.B, function (cPubKey, m1) {
        var login = {
          srp6a: {
            A: cPubKey,
            M1: m1,
            ref: dataStep1.result.srp6a.ref
          }
        }

        self._network.call('POST', 'user/login', login, function (dataStep2) {
          // Check the server proof and we are done!
          if (!srp6a.step2(dataStep2.result.srp6a.M2)) {
            failureCallback(500, 'Server authentication failed')
            return
          }

          successCallback(dataStep2)
        }, failureCallback)
      })
    }, failureCallback)
  }
}
