
import Y from './y.js'
import { BinaryDecoder } from './Encoding.js'

export function formatYjsMessage (buffer) {
  let decoder = new BinaryDecoder(buffer)
  let type = decoder.readVarString()
  let strBuilder = []
  strBuilder.push('\n === ' + type + ' ===\n')
  if (type === 'update') {
    logMessageUpdate(decoder, strBuilder)
  } else if (type === 'sync step 1') {
    logMessageSyncStep1(decoder, strBuilder)
  } else if (type === 'sync step 2') {
    logMessageSyncStep2(decoder, strBuilder)
  } else {
    strBuilder.push('-- Unknown message type - probably an encoding issue!!!')
  }
  return strBuilder.join('')
}

export function formatYjsMessageType (buffer) {
  let decoder = new BinaryDecoder(buffer)
  return decoder.readVarString()
}

export async function logMessageUpdate (decoder, strBuilder) {
  let len = decoder.readUint32()
  for (let i = 0; i < len; i++) {
    strBuilder.push(JSON.stringify(Y.Struct.binaryDecodeOperation(decoder)) + '\n')
  }
}

export async function computeMessageUpdate (decoder, encoder, conn) {
  if (conn.y.db.forwardAppliedOperations) {
    let messagePosition = decoder.pos
    let len = decoder.readUint32()
    let delops = []
    for (let i = 0; i < len; i++) {
      let op = Y.Struct.binaryDecodeOperation(decoder)
      if (op.struct === 'Delete') {
        delops.push(op)
      }
    }
    if (delops.length > 0) {
      conn.broadcastOps(delops)
    }
    decoder.pos = messagePosition
  }
  conn.y.db.applyOperations(decoder)
}

export function logMessageSyncStep1 (decoder, strBuilder) {
  let auth = decoder.readVarString()
  let protocolVersion = decoder.readVarUint()
  let preferUntransformed = decoder.readUint8() === 1
  strBuilder.push(`
  - auth: "${auth}"
  - protocolVersion: ${protocolVersion}
  - preferUntransformed: ${preferUntransformed}
`)
  logSS(decoder, strBuilder)
}

export async function computeMessageSyncStep1 (decoder, encoder, conn, senderConn, sender) {
  let protocolVersion = decoder.readVarUint()
  let preferUntransformed = decoder.readUint8() === 1

  // check protocol version
  if (protocolVersion !== conn.protocolVersion) {
    console.warn(
      `You tried to sync with a yjs instance that has a different protocol version
      (You: ${protocolVersion}, Client: ${protocolVersion}).
      The sync was stopped. You need to upgrade your dependencies (especially Yjs & the Connector)!
      `)
    conn.y.destroy()
  }

  if (conn.role === 'slave') {
    // wait for sync step 2 to complete
    await Promise.all(Array.from(conn.connections.values())
      .filter(conn => conn.role === 'master')
      .map(conn => conn.syncStep2.promise)
    )
  }
  conn.y.db.requestTransaction(function * () {
    encoder.writeVarString('sync step 2')
    encoder.writeVarString(conn.authInfo || '')
    let emptyStateSet = this.ds.length === 0 // TODO: length may not always be available

    if (preferUntransformed && emptyStateSet) {
      encoder.writeUint8(1)
      yield * this.writeOperationsUntransformed(encoder)
    } else {
      encoder.writeUint8(0)
      yield * this.writeOperations(encoder, decoder)
    }

    yield * this.writeDeleteSet(encoder)
    conn.send(senderConn.uid, encoder.createBuffer())
  })
  await conn.y.db.whenTransactionsFinished()
}

export function logSS (decoder, strBuilder) {
  strBuilder.push('  == SS: \n')
  let len = decoder.readUint32()
  for (let i = 0; i < len; i++) {
    let user = decoder.readVarUint()
    let clock = decoder.readVarUint()
    strBuilder.push(`     - ${user}: ${clock}`)
  }
}

export function logOS (decoder, strBuilder) {
  strBuilder.push('  == OS: \n')
  let len = decoder.readUint32()
  for (let i = 0; i < len; i++) {
    let op = Y.Struct.binaryDecodeOperation(decoder)
    strBuilder.push(JSON.stringify(op) + '\n')
  }
}

export function logDS (decoder, strBuilder) {
  strBuilder.push('  == DS: \n')
  let len = decoder.readUint32()
  for (let i = 0; i < len; i++) {
    let user = decoder.readVarUint()
    strBuilder.push(`    User: ${user}: `)
    let len2 = decoder.readVarUint()
    for (let j = 0; j < len2; j++) {
      let from = decoder.readVarUint()
      let to = decoder.readVarUint()
      let gc = decoder.readUint8() === 1
      strBuilder.push(`[${from}, ${to}, ${gc}]`)
    }
  }
}

export function logMessageSyncStep2 (decoder, strBuilder) {
  strBuilder.push('     - auth: ' + decoder.readVarString() + '\n')
  let osTransformed = decoder.readUint8() === 1
  strBuilder.push('     - osUntransformed: ' + osTransformed + '\n')
  logOS(decoder, strBuilder)
  if (osTransformed) {
    logSS(decoder, strBuilder)
  }
  logDS(decoder, strBuilder)
}

export async function computeMessageSyncStep2 (decoder, encoder, conn, senderConn, sender) {
  var db = conn.y.db
  let defer = senderConn.syncStep2

  // apply operations first
  db.requestTransaction(function * () {
    let osUntransformed = decoder.readUint8()
    if (osUntransformed === 1) {
      yield * this.applyOperationsUntransformed(decoder)
    } else {
      this.store.applyOperations(decoder)
    }
  })
  // then apply ds
  await db.whenTransactionsFinished()
  db.requestTransaction(function * () {
    yield * this.applyDeleteSet(decoder)
  })
  await db.whenTransactionsFinished()
  conn._setSyncedWith(sender)
  defer.resolve()
}
