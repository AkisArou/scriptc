import type {
  i8,
  u8,
  i16,
  u16,
  i32,
  u32,
  i64,
  u64,
  usize,
} from "@native-typescript/scabi-c-v1-fixture";
import { exit, type isize, verifyExactIntegers } from "scriptc-native-test";

const signed8Sum = ((127 as i8) + (1 as i8)) as i8;
const signed8 = (signed8Sum | (0 as i8)) as i8;
const unsigned8Zero = ((128 as u8) * (2 as u8)) as u8;
const unsigned8Max = (unsigned8Zero - (1 as u8)) as u8;
const unsigned8 = (unsigned8Max & (255 as u8)) as u8;
const signed16Product = ((16384 as i16) * (2 as i16)) as i16;
const signed16 = (signed16Product ^ (0 as i16)) as i16;
const unsigned16Zero = ((32768 as u16) * (2 as u16)) as u16;
const unsigned16Max = (unsigned16Zero - (1 as u16)) as u16;
const unsigned16 = (unsigned16Max | (0 as u16)) as u16;

const signed32Added = ((2147483647 as i32) + (1 as i32)) as i32;
const signed32Multiplied = ((2147483647 as i32) * (2 as i32)) as i32;
const signed32ProductDelta = (signed32Multiplied - (-2 as i32)) as i32;
const signed32Sum = (signed32Added + signed32ProductDelta) as i32;
const signed32 = (signed32Sum & (-1 as i32)) as i32;
const unsigned32Zero = ((2147483648 as u32) * (2 as u32)) as u32;
const unsigned32Max = (unsigned32Zero - (1 as u32)) as u32;
const unsigned32 = (unsigned32Max ^ (0 as u32)) as u32;

const signed64Product = ((4611686018427387904n as i64) * (2n as i64)) as i64;
const signed64 = (signed64Product | (0n as i64)) as i64;
const unsigned64Zero = ((9223372036854775808n as u64) * (2n as u64)) as u64;
const unsigned64Max = (unsigned64Zero - (1n as u64)) as u64;
const unsigned64 = (unsigned64Max & (18446744073709551615n as u64)) as u64;
const signedSizeProduct = ((4611686018427387904n as isize) * (2n as isize)) as isize;
const signedSize = (signedSizeProduct ^ (0n as isize)) as isize;
const unsignedSizeZero = ((9223372036854775808n as usize) * (2n as usize)) as usize;
const unsignedSizeMax = (unsignedSizeZero - (1n as usize)) as usize;
const unsignedSize = (unsignedSizeMax | (0n as usize)) as usize;

exit(verifyExactIntegers(
  signed8,
  unsigned8,
  signed16,
  unsigned16,
  signed32,
  unsigned32,
  signed64,
  unsigned64,
  signedSize,
  unsignedSize,
));
