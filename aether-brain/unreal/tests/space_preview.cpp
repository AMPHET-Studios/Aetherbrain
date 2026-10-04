// A software picture of the space world, made from the very same maths the Unreal actor uses (AetherSpaceMath.h):
// the generated nebula, galaxy and star pictures; the backdrop layers at two camera positions (parallax); and the
// whole scene (asteroids, ships, shooting stars) around a stand-in brain. It is a check and a preview, not the
// renderer: Unreal draws the real thing. Run with unreal/tests/preview.sh <output folder>.
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherSpaceMath.h"

#include <algorithm>
#include <cstdio>
#include <string>

using namespace AetherSpace;

namespace
{
struct Color
{
	double R = 0.0;
	double G = 0.0;
	double B = 0.0;
};

struct Frame
{
	int W;
	int H;
	std::vector<Color> Px;
	std::vector<double> Depth;
	Frame(int W_, int H_) : W(W_), H(H_), Px(static_cast<size_t>(W_) * static_cast<size_t>(H_)), Depth(static_cast<size_t>(W_) * static_cast<size_t>(H_), 1e30) {}
	Color& At(int X, int Y) { return Px[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)]; }
	double& Z(int X, int Y) { return Depth[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)]; }
};

struct Camera
{
	Vec3 Pos;
	Vec3 Fwd;
	Vec3 Right;
	Vec3 Up;
	double TanH;
	double TanV;
	int W;
	int H;

	Camera(const Vec3& P, const Vec3& LookAt, int W_, int H_, double HorizontalFovDeg) : Pos(P), W(W_), H(H_)
	{
		Fwd = Normalized(LookAt - P);
		// Unreal's axes: X forward, Y right, Z up, so Right = Up x Forward.
		Right = Normalized(Cross(kUp, Fwd), Vec3{0.0, 1.0, 0.0});
		Up = Cross(Fwd, Right);
		TanH = std::tan(DegToRad(HorizontalFovDeg) * 0.5);
		TanV = TanH * static_cast<double>(H) / static_cast<double>(W);
	}

	Vec3 Ray(int X, int Y) const
	{
		const double Sx = (static_cast<double>(X) + 0.5) / static_cast<double>(W) * 2.0 - 1.0;
		const double Sy = 1.0 - (static_cast<double>(Y) + 0.5) / static_cast<double>(H) * 2.0;
		return Normalized(Fwd + Right * (Sx * TanH) + Up * (Sy * TanV));
	}

	bool Project(const Vec3& P, double& Sx, double& Sy, double& Z) const
	{
		const Vec3 V = P - Pos;
		Z = Dot(V, Fwd);
		if (Z <= 1e-3)
		{
			return false;
		}
		Sx = (Dot(V, Right) / Z / TanH * 0.5 + 0.5) * static_cast<double>(W);
		Sy = (0.5 - Dot(V, Up) / Z / TanV * 0.5) * static_cast<double>(H);
		return true;
	}
};

Color Sample(const Image& I, double U, double V)
{
	const double X = Clamp(U, 0.0, 1.0) * static_cast<double>(I.Width - 1);
	const double Y = Clamp(V, 0.0, 1.0) * static_cast<double>(I.Height - 1);
	const int X0 = static_cast<int>(X);
	const int Y0 = static_cast<int>(Y);
	const int X1 = std::min(X0 + 1, I.Width - 1);
	const int Y1 = std::min(Y0 + 1, I.Height - 1);
	const double Fx = X - X0;
	const double Fy = Y - Y0;
	double R[4];
	double G[4];
	double B[4];
	I.Get(X0, Y0, R[0], G[0], B[0]);
	I.Get(X1, Y0, R[1], G[1], B[1]);
	I.Get(X0, Y1, R[2], G[2], B[2]);
	I.Get(X1, Y1, R[3], G[3], B[3]);
	const auto Bi = [&](const double* A) { return Lerp(Lerp(A[0], A[1], Fx), Lerp(A[2], A[3], Fx), Fy); };
	return {Bi(R), Bi(G), Bi(B)};
}

/** A plane sprite, added to the picture (Unreal's additive material). */
void DrawSprite(Frame& F, const Camera& C, const Image& Tex, const Xf& X, double R, double G, double B, double Glow)
{
	const Vec3 N = Rotate(X.Rot, Vec3{0.0, 0.0, 1.0});
	const Vec3 U = Rotate(X.Rot, Vec3{1.0, 0.0, 0.0});
	const Vec3 V = Rotate(X.Rot, Vec3{0.0, 1.0, 0.0});
	const double Half = 50.0 * X.Scale.X;
	double MinX = 1e30;
	double MaxX = -1e30;
	double MinY = 1e30;
	double MaxY = -1e30;
	int Behind = 0;
	for (int K = 0; K < 4; ++K)
	{
		const double Su = (K & 1) ? 1.0 : -1.0;
		const double Sv = (K & 2) ? 1.0 : -1.0;
		double Sx;
		double Sy;
		double Z;
		if (!C.Project(X.Pos + U * (Su * Half) + V * (Sv * Half), Sx, Sy, Z))
		{
			++Behind;
			continue;
		}
		MinX = std::min(MinX, Sx);
		MaxX = std::max(MaxX, Sx);
		MinY = std::min(MinY, Sy);
		MaxY = std::max(MaxY, Sy);
	}
	if (Behind == 4)
	{
		return;
	}
	if (Behind > 0)
	{
		MinX = 0;
		MaxX = F.W;
		MinY = 0;
		MaxY = F.H;
	}
	const int X0 = std::max(0, static_cast<int>(std::floor(MinX)));
	const int X1 = std::min(F.W - 1, static_cast<int>(std::ceil(MaxX)));
	const int Y0 = std::max(0, static_cast<int>(std::floor(MinY)));
	const int Y1 = std::min(F.H - 1, static_cast<int>(std::ceil(MaxY)));
	for (int Py = Y0; Py <= Y1; ++Py)
	{
		for (int Px = X0; Px <= X1; ++Px)
		{
			const Vec3 Dir = C.Ray(Px, Py);
			const double Denom = Dot(Dir, N);
			if (std::fabs(Denom) < 1e-9)
			{
				continue;
			}
			const double T = Dot(X.Pos - C.Pos, N) / Denom;
			if (T <= 0.0)
			{
				continue;
			}
			const Vec3 P = C.Pos + Dir * T - X.Pos;
			const double Lu = Dot(P, U) / Half;
			const double Lv = Dot(P, V) / Half;
			if (std::fabs(Lu) > 1.0 || std::fabs(Lv) > 1.0)
			{
				continue;
			}
			// Sprites are behind every solid (they are the backdrop): only solids drawn later cover them.
			const Color S = Sample(Tex, Lu * 0.5 + 0.5, Lv * 0.5 + 0.5);
			Color& Out = F.At(Px, Py);
			Out.R += S.R * R * Glow;
			Out.G += S.G * G * Glow;
			Out.B += S.B * B * Glow;
		}
	}
}

struct Solid
{
	Prim Shape;
	Xf X;
	Color Albedo;
	double Metal;
	bool Glow;
	double Emit;
};

/** Ray against the unit mesh (extent -0.5..0.5): nearest hit distance and normal, in mesh space. */
bool HitUnit(Prim Shape, const Vec3& O, const Vec3& D, double& T, Vec3& N)
{
	T = 1e30;
	bool Hit = false;
	const auto Try = [&](double Tt, const Vec3& Nn)
	{
		if (Tt > 1e-9 && Tt < T)
		{
			T = Tt;
			N = Nn;
			Hit = true;
		}
	};
	switch (Shape)
	{
	case Prim::Sphere:
	{
		const double A = Dot(D, D);
		const double B = 2.0 * Dot(O, D);
		const double Cc = Dot(O, O) - 0.25;
		const double Disc = B * B - 4.0 * A * Cc;
		if (Disc >= 0.0)
		{
			const double Sq = std::sqrt(Disc);
			for (double Tt : {(-B - Sq) / (2.0 * A), (-B + Sq) / (2.0 * A)})
			{
				Try(Tt, Normalized(O + D * Tt));
			}
		}
		break;
	}
	case Prim::Cube:
	{
		double T0 = -1e30;
		double T1 = 1e30;
		Vec3 N0;
		for (int Axis = 0; Axis < 3; ++Axis)
		{
			const double Oa = Axis == 0 ? O.X : (Axis == 1 ? O.Y : O.Z);
			const double Da = Axis == 0 ? D.X : (Axis == 1 ? D.Y : D.Z);
			if (std::fabs(Da) < 1e-12)
			{
				if (std::fabs(Oa) > 0.5)
				{
					return false;
				}
				continue;
			}
			double Ta = (-0.5 - Oa) / Da;
			double Tb = (0.5 - Oa) / Da;
			double Sign = -1.0;
			if (Ta > Tb)
			{
				std::swap(Ta, Tb);
				Sign = 1.0;
			}
			if (Ta > T0)
			{
				T0 = Ta;
				N0 = Vec3{Axis == 0 ? Sign : 0.0, Axis == 1 ? Sign : 0.0, Axis == 2 ? Sign : 0.0};
			}
			T1 = std::min(T1, Tb);
		}
		if (T0 <= T1 && T1 > 0.0)
		{
			Try(T0, N0);
		}
		break;
	}
	case Prim::Cylinder:
	{
		const double A = D.X * D.X + D.Y * D.Y;
		if (A > 1e-12)
		{
			const double B = 2.0 * (O.X * D.X + O.Y * D.Y);
			const double Cc = O.X * O.X + O.Y * O.Y - 0.25;
			const double Disc = B * B - 4.0 * A * Cc;
			if (Disc >= 0.0)
			{
				const double Sq = std::sqrt(Disc);
				for (double Tt : {(-B - Sq) / (2.0 * A), (-B + Sq) / (2.0 * A)})
				{
					const double Z = O.Z + D.Z * Tt;
					if (std::fabs(Z) <= 0.5)
					{
						Try(Tt, Normalized(Vec3{O.X + D.X * Tt, O.Y + D.Y * Tt, 0.0}));
					}
				}
			}
		}
		if (std::fabs(D.Z) > 1e-12)
		{
			for (double Zc : {-0.5, 0.5})
			{
				const double Tt = (Zc - O.Z) / D.Z;
				const double X = O.X + D.X * Tt;
				const double Y = O.Y + D.Y * Tt;
				if (X * X + Y * Y <= 0.25)
				{
					Try(Tt, Vec3{0.0, 0.0, Zc > 0.0 ? 1.0 : -1.0});
				}
			}
		}
		break;
	}
	case Prim::Cone:
	{
		// Base radius 0.5 at z = -0.5, apex at z = +0.5: x^2 + y^2 = (0.5 (0.5 - z))^2.
		const double K = 0.5;
		const double Oz = 0.5 - O.Z;
		const double A = D.X * D.X + D.Y * D.Y - K * K * D.Z * D.Z;
		const double B = 2.0 * (O.X * D.X + O.Y * D.Y + K * K * Oz * D.Z);
		const double Cc = O.X * O.X + O.Y * O.Y - K * K * Oz * Oz;
		const auto Side = [&](double Tt)
		{
			const double Z = O.Z + D.Z * Tt;
			if (Z >= -0.5 && Z <= 0.5)
			{
				const double X = O.X + D.X * Tt;
				const double Y = O.Y + D.Y * Tt;
				Try(Tt, Normalized(Vec3{X, Y, K * std::sqrt(X * X + Y * Y)}));
			}
		};
		if (std::fabs(A) > 1e-12)
		{
			const double Disc = B * B - 4.0 * A * Cc;
			if (Disc >= 0.0)
			{
				const double Sq = std::sqrt(Disc);
				Side((-B - Sq) / (2.0 * A));
				Side((-B + Sq) / (2.0 * A));
			}
		}
		else if (std::fabs(B) > 1e-12)
		{
			Side(-Cc / B);
		}
		if (std::fabs(D.Z) > 1e-12)
		{
			const double Tt = (-0.5 - O.Z) / D.Z;
			const double X = O.X + D.X * Tt;
			const double Y = O.Y + D.Y * Tt;
			if (X * X + Y * Y <= 0.25)
			{
				Try(Tt, Vec3{0.0, 0.0, -1.0});
			}
		}
		break;
	}
	}
	return Hit;
}

Color Shade(const Solid& S, const Vec3& WorldNormal, const Vec3& View)
{
	if (S.Glow)
	{
		return {S.Albedo.R * S.Emit, S.Albedo.G * S.Emit, S.Albedo.B * S.Emit};
	}
	// The stage's two lights, exposure EV 0 (x 0.83), a Lambert diffuse and a rough specular for metals.
	const double Exposure = 0.83;
	Color Out;
	for (const StageLight* L : {&kKeyLight, &kFillLight})
	{
		const Vec3 ToLight = -LightForward(*L);
		const double Nl = std::max(0.0, Dot(WorldNormal, ToLight));
		const double Diffuse = (1.0 - S.Metal) * Nl * L->Lux / kPi * Exposure;
		const Vec3 Half = Normalized(ToLight + View);
		const double Rough = 0.92 - 0.5 * S.Metal;
		const double Shine = 2.0 / (Rough * Rough * Rough * Rough + 0.01);
		const double Spec = std::pow(std::max(0.0, Dot(WorldNormal, Half)), std::min(Shine, 400.0)) * Nl * (0.04 + 0.5 * S.Metal) * L->Lux / kPi * Exposure * 2.5;
		Out.R += (S.Albedo.R * Diffuse + Spec) * L->R;
		Out.G += (S.Albedo.G * Diffuse + Spec) * L->G;
		Out.B += (S.Albedo.B * Diffuse + Spec) * L->B;
	}
	return Out;
}

void DrawSolid(Frame& F, const Camera& C, const Solid& S)
{
	const double Radius = 50.0 * Length(S.X.Scale);
	double Sx;
	double Sy;
	double Z;
	if (!C.Project(S.X.Pos, Sx, Sy, Z))
	{
		return;
	}
	const double Pix = Radius / Z / C.TanH * 0.5 * static_cast<double>(F.W);
	const int X0 = std::max(0, static_cast<int>(std::floor(Sx - Pix - 1.0)));
	const int X1 = std::min(F.W - 1, static_cast<int>(std::ceil(Sx + Pix + 1.0)));
	const int Y0 = std::max(0, static_cast<int>(std::floor(Sy - Pix - 1.0)));
	const int Y1 = std::min(F.H - 1, static_cast<int>(std::ceil(Sy + Pix + 1.0)));
	if (X1 < X0 || Y1 < Y0 || Pix < 0.05)
	{
		return;
	}
	const Quat Inv{-S.X.Rot.X, -S.X.Rot.Y, -S.X.Rot.Z, S.X.Rot.W};
	const Vec3 Ext{100.0 * S.X.Scale.X, 100.0 * S.X.Scale.Y, 100.0 * S.X.Scale.Z};
	if (Ext.X < 1e-9 || Ext.Y < 1e-9 || Ext.Z < 1e-9)
	{
		return;
	}
	const auto Div = [&](const Vec3& V) { return Vec3{V.X / Ext.X, V.Y / Ext.Y, V.Z / Ext.Z}; };
	const Vec3 O = Div(Rotate(Inv, C.Pos - S.X.Pos));
	for (int Py = Y0; Py <= Y1; ++Py)
	{
		for (int Px = X0; Px <= X1; ++Px)
		{
			const Vec3 Dir = C.Ray(Px, Py);
			const Vec3 D = Div(Rotate(Inv, Dir));
			double T;
			Vec3 N;
			if (!HitUnit(S.Shape, O, D, T, N))
			{
				continue;
			}
			// T is along the unnormalised object-space ray; the same parameter along Dir is the distance.
			if (T >= F.Z(Px, Py))
			{
				continue;
			}
			const Vec3 WorldN = Normalized(Rotate(S.X.Rot, Vec3{N.X / Ext.X, N.Y / Ext.Y, N.Z / Ext.Z}));
			F.Z(Px, Py) = T;
			F.At(Px, Py) = Shade(S, WorldN, -Dir);
		}
	}
}

void BoxBlur(std::vector<Color>& A, int W, int H, int Radius)
{
	std::vector<Color> Tmp(A.size());
	for (int Y = 0; Y < H; ++Y)
	{
		for (int X = 0; X < W; ++X)
		{
			Color Sum;
			for (int K = -Radius; K <= Radius; ++K)
			{
				const Color& P = A[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(std::min(W - 1, std::max(0, X + K)))];
				Sum.R += P.R;
				Sum.G += P.G;
				Sum.B += P.B;
			}
			const double N = 2.0 * Radius + 1.0;
			Tmp[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)] = {Sum.R / N, Sum.G / N, Sum.B / N};
		}
	}
	for (int Y = 0; Y < H; ++Y)
	{
		for (int X = 0; X < W; ++X)
		{
			Color Sum;
			for (int K = -Radius; K <= Radius; ++K)
			{
				const Color& P = Tmp[static_cast<size_t>(std::min(H - 1, std::max(0, Y + K))) * static_cast<size_t>(W) + static_cast<size_t>(X)];
				Sum.R += P.R;
				Sum.G += P.G;
				Sum.B += P.B;
			}
			const double N = 2.0 * Radius + 1.0;
			A[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)] = {Sum.R / N, Sum.G / N, Sum.B / N};
		}
	}
}

void Bloom(Frame& F, double Strength)
{
	const int W = F.W / 4;
	const int H = F.H / 4;
	std::vector<Color> Bright(static_cast<size_t>(W) * static_cast<size_t>(H));
	for (int Y = 0; Y < H; ++Y)
	{
		for (int X = 0; X < W; ++X)
		{
			Color Sum;
			for (int Dy = 0; Dy < 4; ++Dy)
			{
				for (int Dx = 0; Dx < 4; ++Dx)
				{
					const Color& P = F.At(X * 4 + Dx, Y * 4 + Dy);
					const double Lum = std::max(P.R, std::max(P.G, P.B));
					const double K = std::max(0.0, Lum - 0.9) / (Lum + 1e-9);
					Sum.R += P.R * K;
					Sum.G += P.G * K;
					Sum.B += P.B * K;
				}
			}
			Bright[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)] = {Sum.R / 16.0, Sum.G / 16.0, Sum.B / 16.0};
		}
	}
	std::vector<Color> Halo(Bright.size());
	for (int Radius : {2, 5, 12})
	{
		std::vector<Color> Pass = Bright;
		for (int Round = 0; Round < 3; ++Round)
		{
			BoxBlur(Pass, W, H, Radius);
		}
		for (size_t I = 0; I < Halo.size(); ++I)
		{
			Halo[I].R += Pass[I].R;
			Halo[I].G += Pass[I].G;
			Halo[I].B += Pass[I].B;
		}
	}
	for (int Y = 0; Y < F.H; ++Y)
	{
		for (int X = 0; X < F.W; ++X)
		{
			// Bilinear from the quarter-size halo, so it is smooth, not blocky.
			const double Fx = std::min(static_cast<double>(W - 1), std::max(0.0, (static_cast<double>(X) + 0.5) / 4.0 - 0.5));
			const double Fy = std::min(static_cast<double>(H - 1), std::max(0.0, (static_cast<double>(Y) + 0.5) / 4.0 - 0.5));
			const int X0 = static_cast<int>(Fx);
			const int Y0 = static_cast<int>(Fy);
			const int X1 = std::min(W - 1, X0 + 1);
			const int Y1 = std::min(H - 1, Y0 + 1);
			const double Tx = Fx - X0;
			const double Ty = Fy - Y0;
			const auto At = [&](int Xx, int Yy) -> const Color& { return Halo[static_cast<size_t>(Yy) * static_cast<size_t>(W) + static_cast<size_t>(Xx)]; };
			const auto Mix = [&](double A00, double A10, double A01, double A11) { return Lerp(Lerp(A00, A10, Tx), Lerp(A01, A11, Tx), Ty); };
			Color& P = F.At(X, Y);
			P.R += Strength * Mix(At(X0, Y0).R, At(X1, Y0).R, At(X0, Y1).R, At(X1, Y1).R);
			P.G += Strength * Mix(At(X0, Y0).G, At(X1, Y0).G, At(X0, Y1).G, At(X1, Y1).G);
			P.B += Strength * Mix(At(X0, Y0).B, At(X1, Y0).B, At(X0, Y1).B, At(X1, Y1).B);
		}
	}
}

double Aces(double X)
{
	return Clamp01((X * (2.51 * X + 0.03)) / (X * (2.43 * X + 0.59) + 0.14));
}

void WritePpm(const Frame& F, const std::string& Path)
{
	std::FILE* Out = std::fopen(Path.c_str(), "wb");
	if (!Out)
	{
		std::printf("cannot write %s\n", Path.c_str());
		return;
	}
	std::fprintf(Out, "P6\n%d %d\n255\n", F.W, F.H);
	for (const Color& P : F.Px)
	{
		const uint8_t Rgb[3] = {ToSrgb8(Aces(P.R)), ToSrgb8(Aces(P.G)), ToSrgb8(Aces(P.B))};
		std::fwrite(Rgb, 1, 3, Out);
	}
	std::fclose(Out);
}

void WriteImagePpm(const Image& I, const std::string& Path)
{
	std::FILE* Out = std::fopen(Path.c_str(), "wb");
	std::fprintf(Out, "P6\n%d %d\n255\n", I.Width, I.Height);
	for (int Y = 0; Y < I.Height; ++Y)
	{
		for (int X = 0; X < I.Width; ++X)
		{
			const size_t O = I.Offset(X, Y);
			const uint8_t Rgb[3] = {I.Bgra[O + 2], I.Bgra[O + 1], I.Bgra[O]};
			std::fwrite(Rgb, 1, 3, Out);
		}
	}
	std::fclose(Out);
}

struct Textures
{
	std::vector<Image> Nebula;
	std::vector<Image> Galaxy;
	Image Star;
};

Textures MakeTextures(int Size)
{
	Textures T;
	for (int V = 0; V < kNebulaVariants; ++V)
	{
		T.Nebula.push_back(MakeNebula(Size, 100U + static_cast<uint32_t>(V) * 17U));
	}
	for (int V = 0; V < kGalaxyVariants; ++V)
	{
		T.Galaxy.push_back(MakeGalaxy(Size, 200U + static_cast<uint32_t>(V) * 13U, static_cast<GalaxyKind>(V)));
	}
	T.Star = MakeStarDot(64);
	return T;
}

void DrawSky(Frame& F, const Camera& C, const Textures& T, const Vec3& CamPos, double Time)
{
	const std::vector<LayerSpec> Layers = DefaultLayers();
	for (size_t Li = 0; Li < Layers.size(); ++Li)
	{
		const LayerSpec& L = Layers[Li];
		const Vec3 Origin = LayerOrigin(CamPos, L.Follow, L.Radius);
		const Quat Drift = LayerDrift(L, static_cast<uint32_t>(Li), Time);
		const std::vector<SkyItem> Items = BuildLayerItems(L, L.Count, 9000U + static_cast<uint32_t>(Li) * 31U);
		for (const SkyItem& It : Items)
		{
			Xf X = SpriteXf(It, L.Radius);
			X.Pos = Origin + Rotate(Drift, X.Pos);
			X.Rot = Drift * X.Rot;
			const Image& Tex = L.Kind == SpriteKind::Star ? T.Star : (L.Kind == SpriteKind::Nebula ? T.Nebula[static_cast<size_t>(It.Variant)] : T.Galaxy[static_cast<size_t>(It.Variant)]);
			DrawSprite(F, C, Tex, X, It.R, It.G, It.B, It.Glow);
		}
	}
}

/** A stand-in for the brain: a gold sun, project stars, planets and moons, as glowing spheres. */
std::vector<Solid> StandInBrain(double& Radius)
{
	Rng R(31);
	std::vector<Solid> S;
	const auto Sphere = [&](const Vec3& P, double Rad, Color Col, double Glow)
	{
		S.push_back({Prim::Sphere, {P, Quat{}, Vec3{Rad * 2.0 / 100.0, Rad * 2.0 / 100.0, Rad * 2.0 / 100.0}}, Col, 0.0, true, Glow});
	};
	Sphere({0, 0, 0}, 170.0, {1.0, 0.78, 0.35}, 4.0);
	Radius = 3000.0;
	for (int Planet = 0; Planet < 7; ++Planet)
	{
		const double A = Planet * 0.9 + 0.3;
		const double Rad = 600.0 + Planet * 330.0;
		const Vec3 P{Rad * std::cos(A), Rad * std::sin(A), R.Range(-120.0, 120.0)};
		Sphere(P, 80.0 + 12.0 * R.Next(), {0.55, 0.85, 0.5}, 1.5);
		for (int Moon = 0; Moon < 9; ++Moon)
		{
			const Vec3 M = P + R.Unit() * R.Range(160.0, 420.0);
			Sphere(M, R.Range(14.0, 30.0), {0.45, 0.62, 1.0}, 1.2);
		}
		if (Planet % 3 == 1)
		{
			Sphere(P + Vec3{0, 0, 260}, 52.0, {1.0, 0.8, 0.4}, 3.2);
		}
	}
	return S;
}

void CollectSpace(std::vector<Solid>& Solids, double Time, const Vec3& Centre, double Field)
{
	// Asteroids in the belts and zooming through.
	for (const BeltRock& B : BuildBelt(900, 4242U))
	{
		const Pose P = EvalBelt(B, Time, Centre, Field);
		for (int L = 0; L < 3; ++L)
		{
			const double Sh = B.Look.Lumps[L].Shade;
			Solids.push_back({B.Look.Lumps[L].Shape, LumpWorld(B.Look, L, P, 1.0, 1.0), {B.Look.R * Sh, B.Look.G * Sh, B.Look.B * Sh}, B.Look.Metal, false, 0.0});
		}
	}
	for (const FlybyRock& F : BuildFlybyRocks(70, 4243U))
	{
		double Fade = 0.0;
		const Pose P = EvalFlybyRock(F, Time, Centre, Field, Fade);
		if (Fade <= 0.0)
		{
			continue;
		}
		for (int L = 0; L < 3; ++L)
		{
			const double Sh = F.Look.Lumps[L].Shade;
			Solids.push_back({F.Look.Lumps[L].Shape, LumpWorld(F.Look, L, P, Fade, 1.0), {F.Look.R * Sh, F.Look.G * Sh, F.Look.B * Sh}, F.Look.Metal, false, 0.0});
		}
	}
	for (const Streak& S : BuildStreaks(40, 4244U))
	{
		bool Visible = false;
		const Xf X = StreakXf(S, Time, Centre, Field, Visible);
		if (Visible)
		{
			Solids.push_back({Prim::Cylinder, X, {S.R, S.G, S.B}, 0.0, true, S.Glow});
		}
	}
	// Alien ships.
	for (const ShipSpec& S : DefaultFleet(2026U, 1.0))
	{
		const ShipPose Pose = EvalShip(S, Time, Centre, Field);
		if (Pose.Fade <= 0.0)
		{
			continue;
		}
		for (const Part& P : ShipParts(S.Design))
		{
			const PartLook Look = LookOf(S, P.Colour);
			Solids.push_back({P.Shape, PartWorld(P, Pose, S.UnitCm), {Look.R, Look.G, Look.B}, IsGlowTone(P.Colour) ? 0.0 : Look.Extra, IsGlowTone(P.Colour), IsGlowTone(P.Colour) ? Look.Extra : 0.0});
		}
	}
}

Frame RenderScene(const Textures& T, const Camera& C, double Time, bool WithSpace, bool WithBrain = true)
{
	Frame F(C.W, C.H);
	DrawSky(F, C, T, C.Pos, Time);
	double BrainRadius = 3000.0;
	std::vector<Solid> Solids = StandInBrain(BrainRadius);
	if (!WithBrain)
	{
		Solids.clear();
	}
	if (WithSpace)
	{
		CollectSpace(Solids, Time, Vec3{}, FieldRadius(BrainRadius));
	}
	for (const Solid& S : Solids)
	{
		DrawSolid(F, C, S);
	}
	Bloom(F, 0.55);
	return F;
}
} // namespace

/** How many ship parts are drawn (and on screen) at Time: a way to pick a moment worth looking at. */
int ShipsInView(const Camera& C, double Time, double Field)
{
	int N = 0;
	for (const ShipSpec& S : DefaultFleet(2026U, 1.0))
	{
		const ShipPose P = EvalShip(S, Time, Vec3{}, Field);
		double Sx;
		double Sy;
		double Z;
		if (P.Fade > 0.9 && C.Project(P.Pos, Sx, Sy, Z) && Sx > 0 && Sx < C.W && Sy > 0 && Sy < C.H && Z < 40000.0)
		{
			// Bigger when nearer: a ship you can see is worth more than a speck.
			const double Pix = (S.UnitCm * (S.Design == ShipDesign::Mother ? 30.0 : 10.0)) / Z / C.TanH * 0.5 * C.W;
			N += Pix > 14.0 ? 1 : 0;
		}
	}
	return N;
}

/** One of each ship, lit, side by side, so their shapes and which way they face can be checked by eye. */
Frame RenderLineup(int W, int H)
{
	Frame F(W, H);
	const Camera C(Vec3{-1500.0, 0.0, 520.0}, Vec3{0.0, 0.0, 30.0}, W, H, 55.0);
	struct Entry
	{
		ShipDesign Design;
		double Y;
		double Unit;
	};
	const Entry Entries[4] = {{ShipDesign::Saucer, -540.0, 40.0}, {ShipDesign::Dart, -170.0, 36.0}, {ShipDesign::Mother, 250.0, 13.0}, {ShipDesign::Orb, 640.0, 120.0}};
	std::vector<Solid> Solids;
	int Index = 0;
	for (const Entry& E : Entries)
	{
		ShipSpec S;
		S.Design = E.Design;
		S.UnitCm = E.Unit;
		const std::vector<ShipSpec> Fleet = DefaultFleet(2026U, 1.0);
		for (const ShipSpec& Candidate : Fleet)
		{
			if (Candidate.Design == E.Design)
			{
				S = Candidate;
				S.UnitCm = E.Unit;
				break;
			}
		}
		ShipPose Pose;
		Pose.Pos = Vec3{0.0, E.Y, 0.0};
		// Noses pointing to the right of the picture and a little toward us, so the side and the front both show.
		Pose.Rot = LookRotation(Vec3{-0.30, 0.95, 0.10}, kUp);
		for (const Part& P : ShipParts(E.Design))
		{
			const PartLook Look = LookOf(S, P.Colour);
			Solids.push_back({P.Shape, PartWorld(P, Pose, E.Unit), {Look.R, Look.G, Look.B}, IsGlowTone(P.Colour) ? 0.0 : Look.Extra, IsGlowTone(P.Colour), IsGlowTone(P.Colour) ? Look.Extra : 0.0});
		}
		++Index;
	}
	(void)Index;
	for (const Solid& S : Solids)
	{
		DrawSolid(F, C, S);
	}
	Bloom(F, 0.5);
	return F;
}

int main(int Argc, char** Argv)
{
	const std::string Dir = Argc > 1 ? Argv[1] : ".";
	const int W = 1600;
	const int H = 900;

	const Textures T = MakeTextures(256);

	// 1. The generated pictures on one sheet: four nebulae, five galaxies, a star.
	{
		const int Cell = 256;
		Image Sheet(Cell * 5, Cell * 2);
		for (int V = 0; V < kNebulaVariants; ++V)
		{
			for (int Y = 0; Y < Cell; ++Y)
			{
				for (int X = 0; X < Cell; ++X)
				{
					double R;
					double G;
					double B;
					T.Nebula[static_cast<size_t>(V)].Get(X, Y, R, G, B);
					Sheet.Put(V * Cell + X, Y, R, G, B);
				}
			}
		}
		for (int V = 0; V < kGalaxyVariants; ++V)
		{
			for (int Y = 0; Y < Cell; ++Y)
			{
				for (int X = 0; X < Cell; ++X)
				{
					double R;
					double G;
					double B;
					T.Galaxy[static_cast<size_t>(V)].Get(X, Y, R, G, B);
					Sheet.Put(V * Cell + X, Cell + Y, R, G, B);
				}
			}
		}
		for (int Y = 0; Y < 64; ++Y)
		{
			for (int X = 0; X < 64; ++X)
			{
				double R;
				double G;
				double B;
				T.Star.Get(X, Y, R, G, B);
				Sheet.Put(4 * Cell + 96 + X, 96 + Y, R, G, B);
			}
		}
		WriteImagePpm(Sheet, Dir + "/textures.ppm");
	}

	// 2. The whole scene from the home view (as FlyHome frames the brain), 40 s in.
	const double BrainRadius = 3000.0;
	const Vec3 Home = Normalized(Vec3{-1.0, 0.0, 0.45}) * (BrainRadius * 2.1);
	{
		const Camera C(Home, Vec3{}, W, H, 55.0);
		WritePpm(RenderScene(T, C, 40.0, true), Dir + "/scene.ppm");
	}
	// 3. The backdrop alone, before and after the camera flew sideways (same way of looking): far layers coincide
	// (white), nearer ones split into a red copy (before) and a cyan copy (after) - that split is the parallax.
	{
		const Camera A(Home, Vec3{}, W, H, 55.0);
		const Frame Before = RenderScene(T, A, 0.0, false, false);
		const Vec3 Moved = Home + Vec3{0.0, 14000.0, 2500.0};
		const Camera B(Moved, Moved + (Vec3{} - Home), W, H, 55.0);
		const Frame After = RenderScene(T, B, 0.0, false, false);
		Frame Both(W, H);
		for (size_t I = 0; I < Both.Px.size(); ++I)
		{
			const double La = Aces(0.2126 * Before.Px[I].R + 0.7152 * Before.Px[I].G + 0.0722 * Before.Px[I].B);
			const double Lb = Aces(0.2126 * After.Px[I].R + 0.7152 * After.Px[I].G + 0.0722 * After.Px[I].B);
			// Pre-image of Aces so WritePpm's own curve shows these values as they are.
			Both.Px[I] = {La * 1.4, Lb * 1.4, Lb * 1.4};
		}
		WritePpm(Both, Dir + "/parallax.ppm");
		WritePpm(Before, Dir + "/parallax-a.ppm");
		WritePpm(After, Dir + "/parallax-b.ppm");
	}
	// 4. A closer look: the camera drifts beside the brain at the moment the most ships are in view.
	{
		const Vec3 Eye{-9000.0, -4000.0, 1800.0};
		const Camera C(Eye, Vec3{3000.0, 2500.0, 500.0}, W, H, 55.0);
		double BestTime = 0.0;
		int Best = -1;
		for (double Time = 0.0; Time < 1200.0; Time += 1.0)
		{
			const int N = ShipsInView(C, Time, FieldRadius(BrainRadius));
			if (N > Best)
			{
				Best = N;
				BestTime = Time;
			}
		}
		std::printf("close view at t=%.0f s, %d ships in view\n", BestTime, Best);
		WritePpm(RenderScene(T, C, BestTime, true), Dir + "/scene-close.ppm");
	}
	// 5. The four ship designs, side by side.
	WritePpm(RenderLineup(W, 700), Dir + "/ships.ppm");
	std::printf("wrote pictures to %s\n", Dir.c_str());
	return 0;
}
