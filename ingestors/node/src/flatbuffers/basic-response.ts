// automatically generated by the FlatBuffers compiler, do not modify

import * as flatbuffers from 'flatbuffers';

export class BasicResponse {
  bb: flatbuffers.ByteBuffer|null = null;
  bb_pos = 0;
  __init(i:number, bb:flatbuffers.ByteBuffer):BasicResponse {
  this.bb_pos = i;
  this.bb = bb;
  return this;
}

static getRootAsBasicResponse(bb:flatbuffers.ByteBuffer, obj?:BasicResponse):BasicResponse {
  return (obj || new BasicResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

static getSizePrefixedRootAsBasicResponse(bb:flatbuffers.ByteBuffer, obj?:BasicResponse):BasicResponse {
  bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
  return (obj || new BasicResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

status():string|null
status(optionalEncoding:flatbuffers.Encoding):string|Uint8Array|null
status(optionalEncoding?:any):string|Uint8Array|null {
  const offset = this.bb!.__offset(this.bb_pos, 4);
  return offset ? this.bb!.__string(this.bb_pos + offset, optionalEncoding) : null;
}

static startBasicResponse(builder:flatbuffers.Builder) {
  builder.startObject(1);
}

static addStatus(builder:flatbuffers.Builder, statusOffset:flatbuffers.Offset) {
  builder.addFieldOffset(0, statusOffset, 0);
}

static endBasicResponse(builder:flatbuffers.Builder):flatbuffers.Offset {
  const offset = builder.endObject();
  return offset;
}

static createBasicResponse(builder:flatbuffers.Builder, statusOffset:flatbuffers.Offset):flatbuffers.Offset {
  BasicResponse.startBasicResponse(builder);
  BasicResponse.addStatus(builder, statusOffset);
  return BasicResponse.endBasicResponse(builder);
}
}
