// The player character. Screen-space x is fixed; the world scrolls under him.
export class Midio {
  constructor() {
    this.screenX = 220;
    // 625 of a 720 stage. Moved down from 540, then 585, then here: each
    // round traded more ground/underground for more sky, where the sun and
    // moon actually happen. The sea horizon in Ocean.js moves by the same
    // 40px so the whole scene translates rather than the land stretching to
    // meet a fixed sky.
    this.groundY = 625;
    this.y = 0;          // px above ground (from JumpController)
    this.slipX = 0;      // render-only skid offset on iced ground (Traction.js)
    this.ridgeBob = 0;   // render-only lift riding the far skyline (RidgeAnchor.js)
    this.scaleX = 1;
    this.scaleY = 1;
    this.leanDeg = 0;
    this.facing = 1;
    this.halfWidth = 23;
  }

  get renderY() { return this.groundY - this.y + this.ridgeBob; }
}
