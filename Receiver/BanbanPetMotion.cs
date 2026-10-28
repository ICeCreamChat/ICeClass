using Avalonia;

namespace ICeClass.Receiver;

// The same painted rig, curved wrist path and damped springs as banban-rig.js.
// A new intent changes targets; it never resets an arm or body already in motion.
internal sealed class BanbanPetMotion
{
    internal sealed record Action(string Id, string Title, double Seconds);
    internal static readonly Action[] Actions = [
        new("wake", "唤醒跳出", .72), new("wave", "挥手问好", 2.5),
        new("listen", "侧耳倾听", 2.2), new("nod", "轻轻点头", 1.45),
        new("double-nod", "认真点头", 2.1), new("think", "托腮思考", 3.1),
        new("explain", "摊手讲解", 2.6), new("point-left", "向左指引", 2.3),
        new("point-right", "向右指引", 2.3), new("shake", "轻轻摇头", 1.9),
        new("shrug", "歪头疑惑", 2.5), new("bow", "鞠躬致意", 2.3),
        new("wink", "俏皮眨眼", 1.6), new("happy", "开心回应", 2.1),
        new("hop", "完成小跳", 1.6), new("sway", "左右摇摆", 3.2),
        new("stretch", "伸个懒腰", 3.3), new("sleepy", "安静打盹", 3.8),
        new("awaken", "睡醒回神", 2.8), new("peek-left", "向左探头", 2.5),
        new("peek-right", "向右探头", 2.5), new("stop", "停下认真听", 1.65),
        new("walk", "轻快踏步", 3.1), new("settle", "轻轻收回", 1.5)
    ];

    private BanbanPetPose _pose = BanbanPetPose.Rest, _velocity;
    private string _state = "off", _gesture = "";
    private double _time, _stateTime, _gestureTime, _duration;
    private int _variants;
    private bool _right = true;
    internal BanbanPetPose Pose => _pose;
    internal string Gesture => _gesture;

    internal void SetState(string state)
    {
        if (_state == state) return;
        var previous = _state;
        _state = state; _stateTime = 0;
        // Short state updates must not restart an entrance which is still playing.
        if (_gesture == "wake" && state == "listening") return;
        if (state == "thinking") Play("think");
        else if (state == "speaking") Play((++_variants % 3) switch { 0 => "explain", 1 => "point-right", _ => "nod" });
        else if (state == "confirming") Play("shrug");
        else if (state == "error") Play("shake");
        else if (state == "listening") Play(previous == "speaking" ? "listen" : "nod");
        else { _gesture = ""; _gestureTime = 0; }
    }

    internal bool Play(string action, bool right = true)
    {
        var item = Array.Find(Actions, item => item.Id == action);
        if (item is null) return false;
        _gesture = action; _gestureTime = 0; _duration = item.Seconds; _right = right;
        return true;
    }

    internal BanbanPetPose Advance(double seconds, bool reduced = false)
    {
        var dt = Math.Clamp(seconds, 0, .08);
        if (!reduced) { _time += dt; _stateTime += dt; _gestureTime += dt; }
        if (_gestureTime >= _duration) _gesture = "";
        var target = Targets(reduced);
        if (reduced) { _pose = target; _velocity = default; return _pose; }

        Spring(ref _pose.GazeX, ref _velocity.GazeX, target.GazeX, dt, 23);
        Spring(ref _pose.GazeY, ref _velocity.GazeY, target.GazeY, dt, 23);
        Spring(ref _pose.Lean, ref _velocity.Lean, target.Lean, dt);
        Spring(ref _pose.Lift, ref _velocity.Lift, target.Lift, dt);
        Spring(ref _pose.Turn, ref _velocity.Turn, target.Turn, dt);
        Spring(ref _pose.Bow, ref _velocity.Bow, target.Bow, dt);
        // The wrist travels around the cover; give that longer path more time
        // than a facial reaction, including when a new state interrupts it.
        Spring(ref _pose.Think, ref _velocity.Think, target.Think, dt, 7);
        Spring(ref _pose.Smile, ref _velocity.Smile, target.Smile, dt);
        Spring(ref _pose.Concern, ref _velocity.Concern, target.Concern, dt);
        Spring(ref _pose.CloseLeft, ref _velocity.CloseLeft, target.CloseLeft, dt, 52);
        Spring(ref _pose.CloseRight, ref _velocity.CloseRight, target.CloseRight, dt, 48);
        Spring(ref _pose.MouthOpen, ref _velocity.MouthOpen, target.MouthOpen, dt, 27);
        Spring(ref _pose.LeftX, ref _velocity.LeftX, target.LeftX, dt);
        Spring(ref _pose.LeftY, ref _velocity.LeftY, target.LeftY, dt);
        Spring(ref _pose.RightX, ref _velocity.RightX, target.RightX, dt);
        Spring(ref _pose.RightY, ref _velocity.RightY, target.RightY, dt);
        Spring(ref _pose.Ribbon, ref _velocity.Ribbon, target.Ribbon, dt, 8, .58);
        Spring(ref _pose.Hop, ref _velocity.Hop, target.Hop, dt, 22);
        Spring(ref _pose.Squash, ref _velocity.Squash, target.Squash, dt, 24);
        Spring(ref _pose.OffsetX, ref _velocity.OffsetX, target.OffsetX, dt, 18);
        Spring(ref _pose.Step, ref _velocity.Step, target.Step, dt, 20);
        return _pose;
    }

    internal void Rest()
    {
        _gesture = ""; _gestureTime = 0;
        _pose = Targets(true); _velocity = default;
    }

    private BanbanPetPose Targets(bool reduced)
    {
        var p = BanbanPetPose.Rest;
        var thinking = _state == "thinking";
        if (thinking) { p.GazeX = -.42; p.GazeY = -.4; p.Lean = .028; p.Think = reduced ? 1 : Smooth(.18, .72, _stateTime); p.Concern = .45; }
        if (_state == "listening") { p.GazeX = -.1; p.GazeY = .18; p.Lean = -.018; }
        if (_state == "confirming") { p.Lean = -.022; p.Concern = .28; }
        if (_state == "error") { p.Concern = .55; p.Smile = .08; }
        if (reduced) return p;
        p.Lift = Math.Sin(_time * 1.2) * 1.45;
        var blinkTime = _time % 5.9;
        var blink = Smooth(5.48, 5.56, blinkTime) * (1 - Smooth(5.62, 5.76, blinkTime));
        p.CloseLeft = p.CloseRight = blink;
        if (_state == "speaking") p.MouthOpen = Math.Max(0, Math.Sin(_stateTime * 8.2)) * .64;
        var t = _gestureTime;
        var envelope = Smooth(0, .3, t) * (1 - Smooth(_duration - .52, _duration, t));
        var round = Math.Sin(Math.Clamp(t / Math.Max(.01, _duration), 0, 1) * Math.PI);
        switch (_gesture)
        {
            case "wake":
                var phase = Math.Clamp(t / .72, 0, 1);
                p.Hop -= Math.Sin(phase * Math.PI) * 72;
                p.Squash = .065 * Math.Sin(phase * Math.PI * 3) * (1 - phase);
                p.OffsetX = (_right ? 1 : -1) * 105 * Math.Pow(1 - phase, 3);
                p.LeftY -= round * 35; p.RightY -= round * 58;
                p.Smile = .8; p.CloseLeft = p.CloseRight = round * .55;
                break;
            case "wave":
                var wave = Math.Sin(t * 13) * Smooth(.3, .6, t) * (1 - Smooth(1.6, 2.1, t));
                p.LeftX += envelope * (20 + wave * 13); p.LeftY -= envelope * (40 + wave * 8);
                p.Lean += envelope * .025; p.Smile += envelope * .5;
                break;
            case "listen":
                p.LeftX += envelope * 38; p.LeftY -= envelope * 43;
                p.Lean -= envelope * .035; p.GazeY += envelope * .12;
                break;
            case "nod":
            case "double-nod":
                var nod = Math.Pow(Math.Sin(Math.Clamp(t / (_duration - .28), 0, 1) * Math.PI * (_gesture == "nod" ? 1 : 2)), 2) * envelope;
                p.Bow += nod * .55; p.Lift += nod * 4; p.Smile += envelope * .18;
                break;
            case "think":
                p.Think = Math.Max(p.Think, envelope); p.Lean += envelope * .018;
                p.GazeX -= envelope * .2; p.GazeY -= envelope * .2; p.Concern += envelope * .18;
                break;
            case "explain":
                p.RightX += envelope * 38; p.RightY -= envelope * (65 + Math.Sin(t * 3.3) * 9);
                p.GazeX += envelope * .2; p.Lean += envelope * .02;
                break;
            case "point-left":
                p.LeftX -= envelope * 22; p.LeftY -= envelope * 28;
                p.GazeX -= envelope * .65; p.Lean -= envelope * .035;
                break;
            case "point-right":
                p.RightX += envelope * 45; p.RightY -= envelope * 150;
                p.GazeX += envelope * .65; p.Lean += envelope * .025;
                break;
            case "shake":
                var shake = Math.Sin(t * 8.5) * round;
                p.Turn += shake * .065; p.GazeX += shake * .3; p.Lean += shake * .025;
                break;
            case "shrug":
                p.LeftY -= envelope * 17; p.RightX += envelope * 28; p.RightY -= envelope * 97;
                p.Lean -= envelope * .05; p.Concern += envelope * .4;
                break;
            case "bow":
                p.Bow += envelope; p.Lift += envelope * 8;
                p.CloseLeft = p.CloseRight = Math.Max(blink, envelope * .86); p.Smile += envelope * .45;
                break;
            case "wink":
                p.CloseLeft = Math.Max(blink, Smooth(.2, .36, t) * (1 - Smooth(.78, 1.08, t)));
                p.Lean -= envelope * .04; p.Smile += envelope * .55;
                break;
            case "happy":
                p.CloseLeft = p.CloseRight = Math.Max(blink, envelope * .82);
                p.Smile += envelope * .6; p.LeftY -= envelope * 16; p.RightY -= envelope * 43;
                break;
            case "hop":
                p.Hop -= Math.Sin(Math.Clamp((t - .22) / .83, 0, 1) * Math.PI) * 48;
                p.Squash = .06 * Math.Sin(Math.Clamp(t / 1.25, 0, 1) * Math.PI * 3) * envelope;
                p.LeftY -= envelope * 38; p.RightY -= envelope * 85;
                p.Smile += envelope * .6;
                break;
            case "sway":
                p.Lean += Math.Sin(t * 4.6) * envelope * .07;
                p.LeftY -= envelope * (15 + Math.Sin(t * 4.6) * 10);
                p.RightY -= envelope * (43 - Math.Sin(t * 4.6) * 15); p.Smile += envelope * .45;
                break;
            case "stretch":
                p.LeftX += envelope * 66; p.LeftY -= envelope * 57;
                p.RightX -= envelope * 9; p.RightY -= envelope * 235;
                p.Lift -= envelope * 7; p.CloseLeft = p.CloseRight = Math.Max(blink, envelope * .92);
                break;
            case "sleepy":
                p.Lean += envelope * .055; p.Lift += envelope * 5;
                p.CloseLeft = p.CloseRight = Math.Max(blink, envelope * .995);
                p.Smile += envelope * .1;
                break;
            case "awaken":
                var opening = 1 - Smooth(.25, 1.1, t);
                p.CloseLeft = p.CloseRight = Math.Max(blink, opening);
                p.RightY -= envelope * 115; p.LeftY -= envelope * 26;
                p.Lean -= envelope * .035; p.Smile += envelope * .35;
                break;
            case "peek-left":
            case "peek-right":
                var side = _gesture == "peek-left" ? -1 : 1;
                p.OffsetX += side * envelope * 14; p.Lean += side * envelope * .055;
                p.GazeX += side * envelope * .65; p.GazeY -= envelope * .14;
                break;
            case "stop":
                p.LeftX += envelope * 28; p.LeftY -= envelope * 45;
                p.GazeX = 0; p.GazeY = .12; p.MouthOpen = 0; p.Lean -= envelope * .025;
                break;
            case "walk":
                p.Step = Math.Sin(t * 12) * envelope; p.Hop -= Math.Abs(p.Step) * 5;
                p.LeftY -= p.Step * 17; p.RightY += p.Step * 22; p.Lean += envelope * .035;
                break;
            case "settle":
                p.Lean += round * .025; p.Bow += round * .12; p.GazeY += round * .15;
                break;
        }
        p.Turn += p.GazeX * .035;
        p.Ribbon = p.Lean * 1.9 + Math.Sin(_time * 1.1) * .012;
        return p;
    }

    private static void Spring(ref double value, ref double velocity, double target, double dt, double frequency = 14, double damping = .9)
    {
        var steps = Math.Max(1, (int)Math.Ceiling(dt * 120)); var h = dt / steps;
        for (var i = 0; i < steps; i++)
        { velocity += ((target - value) * frequency * frequency - 2 * damping * frequency * velocity) * h; value += velocity * h; }
    }
    internal static double Smooth(double a, double b, double value)
    { var t = Math.Clamp((value - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

    internal static Point RightWrist(BanbanPetPose p) => ThinkWrist(p.Think)
        + new Vector(p.RightX - 607, p.RightY - 548) * (1 - Smooth(0, .5, p.Think));

    internal static Point ThinkWrist(double amount)
    {
        var h = Math.Clamp(amount, 0, 1); var reach = new Point(555 + Math.Sqrt(34 * 34 + 58 * 58) + Math.Sqrt(18 * 18 + 64 * 64) - .001, 426);
        return h < .5 ? Bezier(new(607, 548), new(665, 537), new(reach.X, 470), reach, Smooth(0, 1, h * 2))
            : Bezier(reach, new(reach.X, 382), new(574, 286), new(530, 315), Smooth(0, 1, (h - .5) * 2));
    }
    private static Point Bezier(Point a, Point b, Point c, Point d, double t)
    { var u = 1 - t; return new(u * u * u * a.X + 3 * u * u * t * b.X + 3 * u * t * t * c.X + t * t * t * d.X,
        u * u * u * a.Y + 3 * u * u * t * b.Y + 3 * u * t * t * c.Y + t * t * t * d.Y); }
}

internal struct BanbanPetPose
{
    internal double GazeX, GazeY, Lean, Lift, Turn, Bow, Think, Smile, Concern, CloseLeft, CloseRight,
        MouthOpen, LeftX, LeftY, RightX, RightY, Ribbon, Hop, Squash, OffsetX, Step;
    internal static BanbanPetPose Rest => new() { LeftX = 39, LeftY = 365, RightX = 607, RightY = 548, Smile = .3 };
}
